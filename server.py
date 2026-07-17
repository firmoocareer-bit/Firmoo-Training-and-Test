"""
客服考试结果多维看板 —— Flask 后端
=====================================
提供数据 CRUD API 与三种看板聚合视图（个人 / 批次 / 时间段）。

运行（第一阶段，本地 SQLite）：
    STORAGE_BACKEND=sqlite python server.py
    # 浏览器打开 http://127.0.0.1:5000

切换到云端（第二阶段）：
    STORAGE_BACKEND=cloud CLOUD_ENDPOINT=https://your-api python server.py
"""
import os
import json
import hmac
import hashlib
import datetime
from flask import Flask, request, jsonify, send_from_directory, send_file, session
import io
from storage import get_storage, BACKEND, _HAS_PG

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
# 启动诊断：确认环境变量在 import 时是否已注入 Render 容器
print(f"[BOOT] DATABASE_URL present={bool(os.environ.get('DATABASE_URL'))}, len={len(os.environ.get('DATABASE_URL', ''))}, psycopg2={_HAS_PG}", flush=True)
storage = get_storage()
print(f"[BOOT] selected storage={storage.__class__.__name__}", flush=True)
storage.init()
storage.seed_if_empty()

# 本地鉴权（开发期验证用，云端阶段替换为 Google OAuth）
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")
DEV_MODE = os.environ.get("DEV_MODE", "1") == "1"
ADMIN_PW = os.environ.get("ADMIN_PW", "admin123")  # 上云前务必修改；云端改用 Google SSO
ADMIN_SAFE_KEY = os.environ.get("ADMIN_SAFE_KEY", "firmoo-admin-123")  # 修改密码的安全密钥

# 构建时间戳：用来确认线上跑的是不是最新代码（避免旧 pyc / 端口被占的"幽灵服务"）
BUILD_STAMP = "2026-07-17.36"

# ---------------------------------------------------------------------------
# 跨域（前后端分离部署：前端 Static Site + 后端 Web Service 跨域）
# ---------------------------------------------------------------------------
# FRONTEND_URL：前端站点的 origin（如 https://firmoo-exam-frontend.onrender.com）。
# Render 的 fromService:property=host 只给 hostname，这里自动补成 https://。
# 留空则放行任意 origin（仅用于本地 / 演示）；生产务必在 Render 后端环境变量里填上前端地址。
FRONTEND_URL = os.environ.get("FRONTEND_URL", "")
ALLOWED_ORIGINS = []
for o in FRONTEND_URL.split(","):
    o = o.strip()
    if o:
        # Render fromService(property=host) 只给服务名（如 firmoo-exam-frontend），
        # 需补成完整 https://<name>.onrender.com 才与浏览器实际 origin 匹配。
        if not o.startswith(("http://", "https://")):
            if "." not in o:
                o = o + ".onrender.com"
            o = "https://" + o
        ALLOWED_ORIGINS.append(o)

if not DEV_MODE:
    # 生产环境：跨域凭证 cookie 必须 Secure + SameSite=None，否则浏览器不发登录态。
    app.config["SESSION_COOKIE_SECURE"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "None"
    app.config["SESSION_COOKIE_HTTPONLY"] = True


@app.after_request
def _cors(resp):
    origin = request.headers.get("Origin")
    if origin:
        if not ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Credentials"] = "true"
            resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
            resp.headers["Vary"] = "Origin"
    if request.method == "OPTIONS":
        resp.status_code = 204
        resp.headers["Content-Length"] = "0"
    return resp

# 注意：前端缓存破坏靠 index.html 里写死的 ?v=BUILD_STAMP（Flask 的 static_url_path=""
# 会让 “/” 被静态路由直接 serve，绕过 / 视图里的注入逻辑，故版本戳直接写进 index.html）。
# 每次升级 BUILD_STAMP 时，须同步更新 static/index.html 中 styles.css / i18n.js / app.js 的 ?v= 参数。


def current_user():
    if "role" not in session:
        return None
    return {"role": session.get("role"), "rep_id": session.get("rep_id"),
            "name": session.get("name")}


def _admin_pw_ok(pw):
    """验证管理员密码（哈希比对）。"""
    return storage.verify_admin_password(str(pw or ""))


@app.route("/api/login", methods=["POST"])
def api_login():
    d = request.get_json(force=True, silent=True) or {}
    role = d.get("role")
    if role == "admin":
        if not _admin_pw_ok(d.get("password")):
            return fail("管理员密码错误", 401)
        session["role"] = "admin"
        session["rep_id"] = None
        session["name"] = "管理员"
        return ok({"role": "admin", "name": "管理员", "dev_mode": DEV_MODE})
    if role == "rep":
        name = (d.get("name") or "").strip()
        pw = d.get("password") or ""
        rep = storage.get_rep_by_name(name)
        if not rep:
            return fail("未找到该客服姓名，请确认输入", 401)
        if not storage.verify_rep_password(rep["rep_id"], pw):
            return fail("密码错误", 401)
        session["role"] = "rep"
        session["rep_id"] = rep["rep_id"]
        session["name"] = rep["name"]
        return ok({"role": "rep", "rep_id": rep["rep_id"], "name": rep["name"],
                   "dev_mode": DEV_MODE})
    return fail("无效角色", 400)


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return ok(msg="已退出")


@app.route("/api/me", methods=["GET"])
def api_me():
    return ok(current_user() or {"role": "anon", "dev_mode": DEV_MODE})


@app.route("/api/version", methods=["GET"])
def api_version():
    import storage as _st
    return ok({"backend": "postgres" if "Postgres" in storage.__class__.__name__ else "sqlite",
                "build": BUILD_STAMP,
               "storage_class": storage.__class__.__name__,
               "has_database_url": bool(os.environ.get("DATABASE_URL")),
               "database_url_len": len(os.environ.get("DATABASE_URL", "")),
               "has_psycopg2": _st._HAS_PG,
               "msg": "若此接口返回 HTML 或 404，说明 5000 被其他程序占用，并非本看板"})


@app.before_request
def enforce_role():
    """所有写操作（POST/PUT/DELETE）必须管理员；员工仅能读自己。
    例外：/api/exam/attempt/*（客服开始/提交考试）放行，在路由内校验 rep 身份。"""
    if request.method in ("POST", "PUT", "DELETE"):
        if request.path in ("/api/login", "/api/logout", "/api/me/password"):
            return
        if request.path.startswith("/api/exam/attempt"):
            return
        # 客服学习动作（仅本人，路由内校验 rep 身份）：打开资料 / 提交小测
        parts = request.path.split("/")
        if len(parts) >= 5 and parts[1] == "api" and parts[2] == "materials" and parts[4] == "open":
            return
        if len(parts) >= 5 and parts[1] == "api" and parts[2] == "quiz" and parts[4] == "submit":
            return
        u = current_user()
        if not u or u["role"] != "admin":
            return fail("需要管理员权限", 403)


@app.teardown_appcontext
def _close_db_conn(exc=None):
    # 每请求一条独立 sqlite 连接（见 storage.SQLiteStorage.conn），请求结束后关闭，
    # 避免连接泄漏累积导致文件句柄耗尽 / 写锁长期占用。
    from flask import g
    conn = getattr(g, "db_conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
        g.db_conn = None
    # Postgres 连接（见 storage.PostgresStorage.conn，挂在 g.pg_conn）
    pg = getattr(g, "pg_conn", None)
    if pg is not None:
        try:
            pg.close()
        except Exception:
            pass
        g.pg_conn = None




# ---------------------------------------------------------------------------
# 静态页
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.after_request
def _no_cache_static(resp):
    # 所有前端资源（首页 + app.js/i18n.js/styles.css 等）强制不缓存。
    # 之前只对首页设了 no-cache，而 app.js 等静态资源靠 index.html 里的 ?v= 戳破缓存；
    # 一旦浏览器缓存了旧 ?v 版本的 app.js，就会一直跑旧代码，表现为“改了前端却看不到新功能”。
    # 这里对所有 .html/.js/.css 统一禁用缓存，确保每次刷新都拉到服务端最新文件。
    p = request.path
    if p in ("/", "/index.html") or p.endswith((".html", ".js", ".css")):
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


# ---------------------------------------------------------------------------
# 通用错误包装
# ---------------------------------------------------------------------------
def ok(data=None, msg=""):
    return jsonify({"ok": True, "data": data, "msg": msg})


def fail(msg, code=400):
    return jsonify({"ok": False, "msg": msg}), code


# ---------------------------------------------------------------------------
# 人员（客服总表）
# ---------------------------------------------------------------------------
@app.route("/api/reps", methods=["GET"])
def api_list_reps():
    return ok(storage.list_reps())


@app.route("/api/reps", methods=["POST"])
def api_create_rep():
    d = request.get_json(force=True, silent=True) or {}
    if not d.get("rep_id") or not d.get("name"):
        return fail("工号与姓名必填")
    try:
        return ok(storage.create_rep(d), "已添加客服")
    except Exception as e:
        return fail(f"添加失败：{e}")


@app.route("/api/reps/<rep_id>", methods=["PUT"])
def api_update_rep(rep_id):
    d = request.get_json(force=True, silent=True) or {}
    return ok(storage.update_rep(rep_id, d), "已更新")


@app.route("/api/reps/<rep_id>", methods=["DELETE"])
def api_delete_rep(rep_id):
    storage.delete_rep(rep_id)
    return ok(msg="已删除")


@app.route("/api/reps/<rep_id>/reset-password", methods=["POST"])
def api_reset_rep_password(rep_id):
    # 管理员重置：密码回到默认（默认=工号），返回明文以便告知客服
    pw = storage.reset_rep_password(rep_id)
    return ok({"password": pw}, f"已重置为默认密码：{pw}")


@app.route("/api/reps/batch-delete", methods=["POST"])
def api_batch_delete_reps():
    d = request.get_json(force=True, silent=True) or {}
    ids = d.get("ids") or []
    if not ids:
        return fail("未选择要删除的客服")
    try:
        n = storage.batch_delete_reps(ids)
    except Exception as e:
        return fail(f"删除失败：{e}"), 500
    return ok({"deleted": n}, f"已删除 {n} 名客服")


@app.route("/api/reps/batch-update", methods=["POST"])
def api_batch_update_reps():
    d = request.get_json(force=True, silent=True) or {}
    ids = d.get("ids") or []
    fields = d.get("fields") or {}
    if not ids:
        return fail("未选择要更新的客服")
    if not fields:
        return fail("未提供要更新的字段")
    try:
        n = storage.batch_update_reps(ids, fields)
    except Exception as e:
        return fail(f"更新失败：{e}")
    return ok({"updated": n}, f"已更新 {n} 名客服")


@app.route("/api/reps/import", methods=["POST"])
def api_import_reps():
    f = request.files.get("file")
    if not f:
        return fail("缺少文件")
    import io, openpyxl
    try:
        wb = openpyxl.load_workbook(io.BytesIO(f.read()), read_only=True, data_only=True)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
    except Exception as e:
        return fail(f"Excel 解析失败：{e}")
    if not rows:
        return fail("文件为空")
    header = [str(h).strip() if h is not None else "" for h in rows[0]]
    alias = {
        "rep_id": ["rep_id", "工号", "工號", "employee_id", "id"],
        "name": ["name", "姓名", "名稱", "员工姓名", "員工姓名"],
        "hire_date": ["hire_date", "入职时间", "入職時間", "入职日期", "入職日期"],
        "position": ["position", "职级", "職級", "level"],
        "channel": ["channel", "渠道", "渠道路線"],
        "status": ["status", "状态", "狀態"],
    }
    col = {}
    for key, names in alias.items():
        for idx, h in enumerate(header):
            if h.lower() in [n.lower() for n in names]:
                col[key] = idx
                break
    data = []
    for r in rows[1:]:
        if r is None:
            continue
        rec = {}
        for key, idx in col.items():
            v = r[idx] if idx < len(r) else None
            rec[key] = "" if v is None else str(v).strip()
        if rec.get("rep_id") or rec.get("name"):
            data.append(rec)
    if not data:
        return fail("未识别到任何数据行（请确认表头含 工号/姓名）")
    res = storage.import_reps(data)
    return ok(res, f"导入 {res['imported']} 条，错误 {len(res['errors'])} 条")


@app.route("/api/me/password", methods=["POST"])
def api_change_my_password():
    # 客服修改本人密码（已在 enforce_role 放行，此处再校验身份）
    u = current_user()
    if not u or u["role"] != "rep":
        return fail("仅员工可修改本人密码", 403)
    d = request.get_json(force=True, silent=True) or {}
    old = d.get("old", "")
    new = d.get("new", "")
    if not new:
        return fail("新密码不能为空")
    if not storage.verify_rep_password(u["rep_id"], old):
        return fail("原密码错误", 401)
    storage.set_rep_password(u["rep_id"], new)
    return ok(msg="密码已修改")


# ---------------------------------------------------------------------------
# 考试批次
# ---------------------------------------------------------------------------
@app.route("/api/sessions", methods=["GET"])
def api_list_sessions():
    return ok(storage.list_sessions())


@app.route("/api/sessions/<int:session_id>", methods=["GET"])
def api_get_session(session_id):
    s = storage.get_session(session_id)
    if not s:
        return fail("批次不存在", 404)
    return ok(s)


@app.route("/api/sessions", methods=["POST"])
def api_create_session():
    d = request.get_json(force=True, silent=True) or {}
    if not d.get("exam_name") or not d.get("batch") or not d.get("exam_date"):
        return fail("考试名称、批次、日期必填")
    try:
        return ok(storage.create_session(d, d.get("results")), "已创建考试批次")
    except Exception as e:
        return fail(f"创建失败：{e}")


@app.route("/api/sessions/<int:session_id>", methods=["PUT"])
def api_update_session(session_id):
    d = request.get_json(force=True, silent=True) or {}
    return ok(storage.update_session(session_id, d), "已更新")


@app.route("/api/sessions/<int:session_id>", methods=["DELETE"])
def api_delete_session(session_id):
    storage.delete_session(session_id)
    return ok(msg="已删除")


# ---------------------------------------------------------------------------
# 成绩
# ---------------------------------------------------------------------------
@app.route("/api/results", methods=["GET"])
def api_list_results():
    filters = {
        "rep_id": request.args.get("rep_id"),
        "session_id": request.args.get("session_id"),
        "start_date": request.args.get("start_date"),
        "end_date": request.args.get("end_date"),
        "passed": request.args.get("passed"),
    }
    filters = {k: v for k, v in filters.items() if v not in (None, "")}
    return ok(storage.list_results(filters))


@app.route("/api/results", methods=["POST"])
def api_create_result():
    d = request.get_json(force=True, silent=True) or {}
    if not d.get("session_id") or not d.get("rep_id") or not d.get("name"):
        return fail("批次、工号、姓名必填")
    try:
        return ok(storage.create_result(d), "已添加成绩")
    except Exception as e:
        return fail(f"添加失败：{e}")


@app.route("/api/results/<int:result_id>", methods=["PUT"])
def api_update_result(result_id):
    d = request.get_json(force=True, silent=True) or {}
    return ok(storage.update_result(result_id, d), "已更新")


@app.route("/api/results/<int:result_id>", methods=["DELETE"])
def api_delete_result(result_id):
    storage.delete_result(result_id)
    return ok(msg="已删除")


@app.route("/api/results/import", methods=["POST"])
def api_import_results():
    """网页批量上传成绩 Excel（问卷星式导出，1 文件 = 1 批次）。"""
    f = request.files.get("file")
    if not f:
        return fail("未收到文件")
    form = request.form
    def _num(key):
        v = form.get(key)
        try:
            return float(v) if v not in (None, "") else None
        except ValueError:
            return None
    path = os.path.join(BASE_DIR, "data", "_import_results_tmp.xlsx")
    f.save(path)
    try:
        r = storage.import_results_excel(
            path,
            exam_name=(form.get("exam_name") or "").strip() or None,
            batch=(form.get("batch") or "").strip() or None,
            exam_date=(form.get("exam_date") or "").strip() or None,
            pass_ratio=_num("pass_ratio") if _num("pass_ratio") is not None else 0.7,
            full_score=_num("full_score"),
            pass_score=_num("pass_score"),
            orig_filename=f.filename,
        )
    except Exception as e:
        return fail(f"导入失败：{e}")
    finally:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass  # 临时文件清理失败不影响导入结果（如沙箱回收站不可用）
    return ok(r, f"已导入「{r['exam_name']} [{r['batch']}]」，{r['count']} 人，"
                 f"及格线 {r['pass_score']}（{r['q_count']} 道小题）"
                 + (r.get("warning") or ""))


@app.route("/api/reset", methods=["POST"])
def api_reset():
    """清空考试数据（仅管理员）。scope: all|results|online。需二次确认 + 密码授权。"""
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    d = request.get_json(force=True, silent=True) or {}
    scope = d.get("scope", "all")
    if scope not in ("all", "results", "online"):
        return fail("未知 scope", 400)
    if d.get("confirm") is not True:
        return fail("需确认", 400)
    if not _admin_pw_ok(d.get("password")):
        return fail("密码错误，无法清空", 403)
    try:
        r = storage.reset_all_data(scope=scope)
    except Exception as e:
        return fail(f"清空失败：{e}")
    return ok(r, f"已清空数据（scope={scope}）")


# ---------------------------------------------------------------------------
# 看板视图
# ---------------------------------------------------------------------------
@app.route("/api/views/individual", methods=["GET"])
def api_view_individual():
    u = current_user()
    rep_id = request.args.get("rep_id")
    if u and u["role"] == "rep":
        rep_id = u["rep_id"]  # 员工只能看自己
        if not rep_id:
            return fail("未登录", 401)
    if not rep_id:
        return fail("请提供 rep_id")
    data = storage.individual_view(rep_id)
    if not data:
        return fail("未找到该客服", 404)
    return ok(data)


@app.route("/api/views/batch", methods=["GET"])
def api_view_batch():
    sid = request.args.get("session_id")
    if not sid:
        return fail("请提供 session_id")
    data = storage.batch_view(int(sid))
    if not data:
        return fail("未找到该批次", 404)
    return ok(data)


@app.route("/api/views/period", methods=["GET"])
def api_view_period():
    start = request.args.get("start")
    end = request.args.get("end")
    if not start or not end:
        return fail("请提供 start 与 end 日期")
    return ok(storage.period_view(start, end))


@app.route("/api/overview", methods=["GET"])
def api_overview():
    return ok(storage.overview())


@app.route("/api/backend", methods=["GET"])
def api_backend():
    return ok({"backend": BACKEND})


# ---------------------------------------------------------------------------
# 知识维度
# ---------------------------------------------------------------------------
@app.route("/api/dimensions", methods=["GET"])
def api_list_dimensions():
    return ok(storage.list_dimensions())


@app.route("/api/dimensions", methods=["POST"])
def api_create_dimension():
    d = request.get_json(force=True, silent=True) or {}
    if not d.get("name_cn"):
        return fail("维度中文名必填")
    try:
        return ok(storage.create_dimension(d), "已添加维度")
    except Exception as e:
        return fail(f"添加失败：{e}")


@app.route("/api/dimensions/<int:dim_id>", methods=["PUT"])
def api_update_dimension(dim_id):
    d = request.get_json(force=True, silent=True) or {}
    return ok(storage.update_dimension(dim_id, d), "已更新")


@app.route("/api/dimensions/<int:dim_id>", methods=["DELETE"])
def api_delete_dimension(dim_id):
    storage.delete_dimension(dim_id)
    return ok(msg="已删除")


# 题 → 维度映射
@app.route("/api/exam-question-dimensions", methods=["GET"])
def api_get_qdims():
    exam_name = request.args.get("exam_name")
    if not exam_name:
        return fail("请提供 exam_name")
    return ok(storage.get_exam_question_dimensions(exam_name))


@app.route("/api/exam-question-dimensions", methods=["POST"])
def api_set_qdim():
    d = request.get_json(force=True, silent=True) or {}
    if not d.get("exam_name") or not d.get("q_number") or not d.get("dim_id"):
        return fail("exam_name / q_number / dim_id 必填")
    try:
        return ok(storage.set_question_dimension(
            d["exam_name"], d["q_number"], int(d["dim_id"]), d.get("max_score")), "已映射")
    except Exception as e:
        return fail(f"映射失败：{e}")


@app.route("/api/exam-question-dimensions", methods=["DELETE"])
def api_del_qdim():
    d = request.get_json(force=True, silent=True) or {}
    if not d.get("exam_name") or not d.get("q_number") or not d.get("dim_id"):
        return fail("exam_name / q_number / dim_id 必填")
    storage.delete_question_dimension(d["exam_name"], d["q_number"], int(d["dim_id"]))
    return ok(msg="已删除映射")


# ---------------------------------------------------------------------------
# 维度分析视图
# ---------------------------------------------------------------------------
@app.route("/api/views/exam-dimensions", methods=["GET"])
def api_view_exam_dimensions():
    exam_name = request.args.get("exam_name")
    if not exam_name:
        return fail("请提供 exam_name")
    return ok(storage.exam_dimension_distribution(exam_name))


@app.route("/api/views/rep-weakness", methods=["GET"])
def api_view_rep_weakness():
    u = current_user()
    rep_id = request.args.get("rep_id")
    if u and u["role"] == "rep":
        rep_id = u["rep_id"]  # 员工只能看自己
        if not rep_id:
            return fail("未登录", 401)
    if not rep_id:
        return fail("请提供 rep_id")
    sid_raw = request.args.get("session_ids")
    session_ids = None
    if sid_raw:
        try:
            session_ids = [int(x) for x in sid_raw.split(",") if x.strip()]
        except ValueError:
            return fail("session_ids 格式错误（需为逗号分隔的数字）")
    data = storage.rep_dimension_weakness(rep_id, session_ids=session_ids)
    return ok(data or {})


@app.route("/api/views/rep-score-rates", methods=["GET"])
def api_view_rep_score_rates():
    scope = request.args.get("scope", "avg")
    session_id = request.args.get("session_id")
    if scope not in ("avg", "session"):
        scope = "avg"
    return ok(storage.rep_score_rates(scope=scope, session_id=session_id))


@app.route("/api/admin/recompute-score-rates", methods=["POST"])
def api_recompute_score_rates():
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    return ok(storage.recompute_score_rates(), "已按新标准重算历史成绩")


@app.route("/api/system-config", methods=["GET"])
def api_get_system_config():
    keys = request.args.get("keys")
    if keys:
        return ok({k: storage.get_config(k) for k in keys.split(",")})
    try:
        rules = storage.get_points_rules()
    except Exception:
        rules = None
    return ok({
        "pass_line_ratio": storage.get_config("pass_line_ratio", "0.88"),
        "points_threshold": storage.get_config("points_threshold", "100"),
        "points_period": storage.get_config("points_period", "quarter"),
        "period_target": int(float(storage.get_config("points_period_target", "0") or 0)),
        "recommend_top_n": storage.get_config("recommend_top_n", "3"),
        "recommend_quiz_n": storage.get_config("recommend_quiz_n", "5"),
        "points_rules": rules,
    })


@app.route("/api/system-config", methods=["PUT"])
def api_set_system_config():
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    d = request.get_json(force=True, silent=True) or {}
    if "pass_line_ratio" in d:
        try:
            v = float(d["pass_line_ratio"])
        except (TypeError, ValueError):
            return fail("及格线比例必须为数字（0~1，如 0.88 表示 88%）")
        if not (0 < v <= 1):
            return fail("及格线比例须在 0~1 之间（0.88 表示 88%）")
        storage.set_config("pass_line_ratio", str(v))
    if "recommend_top_n" in d:
        try:
            n = int(d["recommend_top_n"])
            if n < 1:
                return fail("推荐弱项数量须 ≥ 1")
            storage.set_config("recommend_top_n", str(n))
        except (TypeError, ValueError):
            return fail("推荐弱项数量必须为整数")
    if "recommend_quiz_n" in d:
        try:
            n = int(d["recommend_quiz_n"])
            if n < 1:
                return fail("小测题量须 ≥ 1")
            storage.set_config("recommend_quiz_n", str(n))
        except (TypeError, ValueError):
            return fail("小测题量必须为整数")
    rules = d.get("points_rules")
    threshold = d.get("points_threshold")
    # 积分达标阈值：必须是非负整数，避免 int() 抛错导致 500
    if threshold is not None:
        try:
            threshold = int(threshold)
            if threshold < 0:
                return fail("积分达标阈值必须为非负整数")
        except (TypeError, ValueError):
            return fail("积分达标阈值必须为整数")
    period = d.get("points_period")
    if period is not None and period not in ("month", "quarter"):
        return fail("周期目标粒度须为 month 或 quarter")
    period_target = d.get("points_period_target")
    if period_target is not None:
        try:
            period_target = int(period_target)
            if period_target < 0:
                return fail("周期目标积分必须为非负整数")
        except (TypeError, ValueError):
            return fail("周期目标积分必须为整数")
    res = storage.update_points_config(rules=rules, threshold=threshold,
                                        period=period, period_target=period_target)
    return ok(res, "已保存系统设置")


@app.route("/api/points/summary", methods=["GET"])
def api_points_summary():
    year = request.args.get("year", type=int)
    return ok(storage.points_year_summary(year))


@app.route("/api/points/years", methods=["GET"])
def api_points_years():
    return ok(storage.list_point_years())


@app.route("/api/points/me", methods=["GET"])
def api_points_me():
    u = current_user()
    if not u:
        return fail("未登录", 401)
    return ok(storage.rep_points(u.get("rep_id"), year=datetime.datetime.now().year))


@app.route("/api/points/<rep_id>/log", methods=["GET"])
def api_points_log(rep_id):
    year = request.args.get("year", type=int)
    return ok(storage.rep_points_log(rep_id, year))


# ---------------------------------------------------------------------------
# 学习资料库 / 智能推荐 / 小测
# ---------------------------------------------------------------------------
@app.route("/api/materials", methods=["GET"])
def api_list_materials():
    dim_id = request.args.get("dim_id")
    mats = storage.list_materials(int(dim_id) if dim_id else None)
    return ok(mats)


@app.route("/api/materials", methods=["POST"])
def api_create_material():
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    f = request.files.get("file")
    file_path = None
    if f and f.filename:
        import re as _re
        from werkzeug.utils import secure_filename
        safe = secure_filename(f.filename)
        safe = _re.sub(r"[^\w.\-]", "_", safe) or "upload.bin"
        mdir = os.path.join(BASE_DIR, "data", "materials")
        os.makedirs(mdir, exist_ok=True)
        file_path = os.path.join("data", "materials", f"{int(__import__('time').time())}_{safe}")
        f.save(os.path.join(BASE_DIR, file_path))
    data = request.form.to_dict() if request.form else {}
    if not data:
        data = request.get_json(force=True, silent=True) or {}
    data = dict(data)
    if file_path:
        data["file_path"] = file_path
    # 支持多维度：表单可能提交 dim_ids(逗号串/多值) 或旧字段 dim_id
    raw_dims = request.form.getlist("dim_ids") if request.form else []
    if raw_dims:
        # 多值或逗号串统一成逗号串交给 storage 解析
        flat = []
        for x in raw_dims:
            flat.extend(str(x).split(","))
        data["dim_ids"] = ",".join(flat)
    elif "dim_ids" in data and isinstance(data.get("dim_ids"), list):
        data["dim_ids"] = ",".join(str(x) for x in data["dim_ids"])
    if not data.get("title"):
        return fail("请填写资料标题")
    return ok(storage.create_material(data), "已创建学习资料")


@app.route("/api/materials/<int:mid>", methods=["DELETE"])
def api_delete_material(mid):
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    storage.delete_material(mid)
    return ok(msg="已删除")


@app.route("/api/materials/<int:mid>", methods=["GET"])
def api_get_material(mid):
    m = storage.get_material(mid)
    if not m:
        return fail("资料不存在", 404)
    return ok(m)


@app.route("/api/materials/<int:mid>", methods=["PUT"])
def api_update_material(mid):
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    f = request.files.get("file")
    file_path = None
    if f and f.filename:
        import re as _re
        from werkzeug.utils import secure_filename
        safe = secure_filename(f.filename)
        safe = _re.sub(r"[^\w.\-]", "_", safe) or "upload.bin"
        mdir = os.path.join(BASE_DIR, "data", "materials")
        os.makedirs(mdir, exist_ok=True)
        file_path = os.path.join("data", "materials", f"{int(__import__('time').time())}_{safe}")
        f.save(os.path.join(BASE_DIR, file_path))
    data = request.form.to_dict() if request.form else {}
    if not data:
        data = request.get_json(force=True, silent=True) or {}
    data = dict(data)
    if file_path:
        data["file_path"] = file_path
    raw_dims = request.form.getlist("dim_ids") if request.form else []
    if raw_dims:
        flat = []
        for x in raw_dims:
            flat.extend(str(x).split(","))
        data["dim_ids"] = ",".join(flat)
    elif "dim_ids" in data and isinstance(data.get("dim_ids"), list):
        data["dim_ids"] = ",".join(str(x) for x in data["dim_ids"])
    if not data.get("title"):
        return fail("请填写资料标题")
    return ok(storage.update_material(mid, data), "已更新学习资料")


@app.route("/api/materials/<int:mid>/file")
def api_material_file(mid):
    m = storage.get_material(mid)
    if not m or not m.get("file_path"):
        return fail("无文件", 404)
    fp = os.path.join(BASE_DIR, m["file_path"])
    if not os.path.exists(fp):
        return fail("文件不存在", 404)
    return send_file(fp, as_attachment=True)


@app.route("/api/materials/<int:mid>/open", methods=["POST"])
def api_open_material(mid):
    u = current_user()
    if not u:
        return fail("未登录", 401)
    storage.mark_material_opened(u.get("rep_id"), mid)
    return ok(msg="已记录浏览")


@app.route("/api/quiz/draw", methods=["GET"])
def api_quiz_draw():
    u = current_user()
    if not u:
        return fail("未登录", 401)
    dim_id = request.args.get("dim_id")
    n = int(request.args.get("n") or 5)
    if not dim_id:
        return fail("缺少维度 dim_id")
    qs = storage.draw_quiz_questions(int(dim_id), n)
    if not qs:
        return fail("该维度暂无可选题目", 400)
    quiz_id = storage.create_mini_quiz(u.get("rep_id"), int(dim_id), [q["question_id"] for q in qs])
    return ok({"quiz_id": quiz_id, "dim_id": int(dim_id), "questions": qs})


@app.route("/api/quiz/<int:quiz_id>/submit", methods=["POST"])
def api_quiz_submit(quiz_id):
    u = current_user()
    if not u:
        return fail("未登录", 401)
    d = request.get_json(force=True, silent=True) or {}
    res = storage.grade_mini_quiz(quiz_id, d.get("answers", {}))
    if "error" in res:
        return fail(res["error"], 400)
    return ok(res, "小测已判分")


@app.route("/api/recommend", methods=["GET"])
def api_recommend():
    u = current_user()
    if not u:
        return fail("未登录", 401)
    n = int(request.args.get("top_n") or storage.get_recommend_top_n())
    qn = int(request.args.get("quiz_n") or storage.get_recommend_quiz_n())
    return ok(storage.recommend_for_rep(u.get("rep_id"), top_n=n, quiz_n=qn))


# ---------------------------------------------------------------------------
# 题库 / 在线考试
# ---------------------------------------------------------------------------
@app.route("/api/questions", methods=["GET"])
def api_questions():
    filters = {"q_type": request.args.get("q_type"), "category": request.args.get("category"),
               "dim_id": request.args.get("dim_id"), "keyword": request.args.get("keyword")}
    filters = {k: v for k, v in filters.items() if v}
    return ok(storage.list_questions(filters))


@app.route("/api/questions", methods=["POST"])
def api_create_question():
    d = request.get_json(force=True, silent=True) or {}
    if not d.get("content"):
        return fail("题面必填")
    try:
        return ok(storage.create_question(d), "已添加题目")
    except Exception as e:
        return fail(f"添加失败：{e}")


@app.route("/api/questions/<int:qid>", methods=["PUT"])
def api_update_question(qid):
    d = request.get_json(force=True, silent=True) or {}
    return ok(storage.update_question(qid, d), "已更新")


@app.route("/api/questions/<int:qid>", methods=["DELETE"])
def api_delete_question(qid):
    storage.delete_question(qid)
    return ok(msg="已删除")


@app.route("/api/questions/bulk", methods=["DELETE"])
def api_bulk_delete_questions():
    """批量删除题目：{ids:[...]}。一次删除多题（含关联数据与附件文件）。"""
    d = request.get_json(force=True, silent=True) or {}
    ids = d.get("ids") or []
    if not ids:
        return fail("未选择题目")
    try:
        n = storage.bulk_delete_questions(ids)
    except Exception as e:
        return fail(f"批量删除失败：{e}")
    return ok({"deleted": n}, f"已删除 {n} 道题")


@app.route("/api/questions/bulk-source", methods=["POST"])
def api_bulk_question_source():
    """批量设置题目来源（source_exam）：{ids:[...], source_exam:"..."}。
    一次给多题写入同一来源，免去逐题填写。"""
    d = request.get_json(force=True, silent=True) or {}
    ids = d.get("ids") or []
    source = (d.get("source_exam") or "").strip()
    if not ids:
        return fail("未选择题目")
    try:
        n = storage.bulk_set_question_source(ids, source)
    except Exception as e:
        return fail(f"批量更新失败：{e}")
    return ok({"updated": n}, f"已更新 {n} 题来源")


# ---------------------------------------------------------------------------
# 各板块批量删除（独立于「清空全部数据」，按需精确清理）
# ---------------------------------------------------------------------------
@app.route("/api/sessions/bulk", methods=["DELETE"])
def api_bulk_delete_sessions():
    """批量删除考试批次：{ids:[session_id...]}，每批级联删除其成绩。"""
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    d = request.get_json(force=True, silent=True) or {}
    ids = d.get("ids") or []
    if not ids:
        return fail("未选择批次")
    try:
        n = storage.bulk_delete_sessions(ids)
    except Exception as e:
        return fail(f"批量删除失败：{e}")
    return ok({"deleted": n}, f"已删除 {n} 个批次")


@app.route("/api/results/bulk", methods=["DELETE"])
def api_bulk_delete_results():
    """批量删除成绩记录：{ids:[result_id...]}。"""
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    d = request.get_json(force=True, silent=True) or {}
    ids = d.get("ids") or []
    if not ids:
        return fail("未选择成绩")
    try:
        n = storage.bulk_delete_results(ids)
    except Exception as e:
        return fail(f"批量删除失败：{e}")
    return ok({"deleted": n}, f"已删除 {n} 条成绩")


@app.route("/api/admin/change-password", methods=["POST"])
def api_change_admin_password():
    """修改管理员密码（需要当前密码 + 安全密钥验证）。"""
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    d = request.get_json(force=True, silent=True) or {}
    current_pw = d.get("current_password")
    new_pw = d.get("new_password")
    safe_key = d.get("safe_key")

    if not current_pw or not new_pw:
        return fail("当前密码和新密码都不能为空", 400)
    if len(new_pw) < 4:
        return fail("新密码至少 4 个字符", 400)
    if safe_key != ADMIN_SAFE_KEY:
        return fail("安全密钥错误", 401)

    if not _admin_pw_ok(current_pw):
        return fail("当前密码错误", 401)

    storage.update_admin_password(new_pw)
    return ok({}, "管理员密码修改成功")


@app.route("/api/questions/banks/bulk", methods=["DELETE"])
def api_bulk_delete_question_banks():
    """批量删除整套上传题库：{names:[exam_name...]}。"""
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    d = request.get_json(force=True, silent=True) or {}
    names = d.get("names") or []
    if not names:
        return fail("未选择题库")
    try:
        n = storage.bulk_delete_question_banks(names)
    except Exception as e:
        return fail(f"批量删除失败：{e}")
    return ok({"deleted": n}, f"已删除 {n} 套题库")


@app.route("/api/materials/bulk", methods=["DELETE"])
def api_bulk_delete_materials():
    """批量删除学习资料：{ids:[material_id...]}。"""
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    d = request.get_json(force=True, silent=True) or {}
    ids = d.get("ids") or []
    if not ids:
        return fail("未选择资料")
    try:
        n = storage.bulk_delete_materials(ids)
    except Exception as e:
        return fail(f"批量删除失败：{e}")
    return ok({"deleted": n}, f"已删除 {n} 份资料")


@app.route("/api/dimensions/bulk", methods=["DELETE"])
def api_bulk_delete_dimensions():
    """批量删除知识维度：{ids:[dim_id...]}，连带清理其题→维度映射。"""
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("无权限", 403)
    d = request.get_json(force=True, silent=True) or {}
    ids = d.get("ids") or []
    if not ids:
        return fail("未选择维度")
    try:
        n = storage.bulk_delete_dimensions(ids)
    except Exception as e:
        return fail(f"批量删除失败：{e}")
    return ok({"deleted": n}, f"已删除 {n} 个维度")


@app.route("/api/questions/import", methods=["POST"])
def api_import_questions():
    f = request.files.get("file")
    if not f:
        return fail("未收到文件")
    path = os.path.join(BASE_DIR, "data", "_import_tmp.xlsx")
    f.save(path)
    try:
        r = storage.import_questions_excel(path)
    except Exception as e:
        return fail(f"导入失败：{e}")
    finally:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass  # 临时文件清理失败不影响导入结果（如沙箱回收站不可用）
    return ok(r, f"导入 {r['imported']} 题，错误 {len(r['errors'])}")


@app.route("/api/questions/import-ppt", methods=["POST"])
def api_import_questions_ppt():
    """上传考题原始 PPT（含题目/选项/正确答案/解析），解析后写入题库并与指定考试联动。
    表单字段：file(pptx)、exam_name(必填，与已有考试批次对应)、
    dim_ids(维度ID列表，逗号分隔，如 "1,2"；支持一题多维度自由组合)。"""
    f = request.files.get("file")
    if not f:
        return fail("未收到文件")
    dry = bool(request.args.get("dry") or request.form.get("dry"))
    exam_name = (request.form.get("exam_name") or "").strip()
    # 预览模式仅解析不落库，无需关联考试；正式导入才必填 exam_name
    if not dry and not exam_name:
        return fail("请指定对应的考试名称（exam_name）")
    dim_raw = (request.form.get("dim_ids") or request.form.get("dim_id") or "").strip()
    dim_ids = []
    if dim_raw:
        for part in dim_raw.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                dim_ids.append(int(part))
            except ValueError:
                return fail("dim_ids 必须为数字，多个用逗号分隔")
    path = os.path.join(BASE_DIR, "data", "_import_ppt_tmp.pptx")
    f.save(path)
    try:
        # 预览模式：仅解析不落库，供上传前确认题数/内容
        if request.args.get("dry") or request.form.get("dry"):
            r = storage.preview_questions_ppt(path)
            return ok(r, f"预览：解析到 {r['count']} 道题（已忽略 {r['skipped']} 个非题目块）")
        r = storage.import_questions_ppt(
            path, exam_name=exam_name, dim_ids=dim_ids, orig_filename=f.filename)
    except Exception as e:
        return fail(f"PPT 解析失败：{e}")
    finally:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    msg = f"已从 PPT 解析并导入「{r['exam_name']}」{r['count']} 道题"
    if r.get("warning"):
        msg += f"；⚠️ {r['warning']}"
    return ok(r, msg)


@app.route("/api/questions/banks", methods=["GET"])
def api_list_question_banks():
    """列出所有已上传考题 PPT（按考试聚合），供「考题 PPT 管理」面板。"""
    return ok(storage.list_question_banks())


# ---- 题目附件（图片等） ----
@app.route("/api/questions/<int:qid>/attachments", methods=["POST"])
def api_upload_question_attachment(qid):
    f = request.files.get("file")
    if not f:
        return fail("未收到文件")
    try:
        att = storage.add_question_attachment(qid, f, f.filename, f.mimetype or "application/octet-stream")
    except Exception as e:
        return fail(f"上传失败：{e}")
    return ok(att, "已添加附件")


@app.route("/api/questions/<int:qid>/attachments", methods=["GET"])
def api_list_question_attachments(qid):
    return ok(storage.list_question_attachments(qid))


@app.route("/api/questions/attachments/<int:att_id>", methods=["DELETE"])
def api_delete_question_attachment(att_id):
    storage.delete_question_attachment(att_id)
    return ok(msg="已删除附件")


@app.route("/api/attachments/<int:att_id>", methods=["GET"])
def api_serve_attachment(att_id):
    att = storage.get_attachment(att_id)
    if not att or att.get("data") is None:
        return fail("附件不存在", 404)
    return send_file(io.BytesIO(att["data"]),
                     mimetype=att.get("mime") or "application/octet-stream",
                     as_attachment=False)


@app.route("/api/questions/banks", methods=["DELETE"])
def api_delete_question_bank():
    """删除某考试对应的整套上传题库（PPT 关联）。参数：exam_name（query 或 JSON）。
    仅清题库与维度映射，不影响考试成绩本身。"""
    exam_name = (request.args.get("exam_name")
                 or (request.get_json(silent=True) or {}).get("exam_name") or "").strip()
    if not exam_name:
        return fail("请指定要删除的考试名称（exam_name）")
    try:
        r = storage.delete_question_bank(exam_name)
    except Exception as e:
        return fail(f"删除失败：{e}")
    return ok(r, f"已删除「{exam_name}」的上传题库及其考试关联")


@app.route("/api/questions/export", methods=["GET"])
def api_export_questions():
    path = storage.export_questions_excel()
    return send_from_directory(os.path.dirname(path), os.path.basename(path), as_attachment=True)


@app.route("/api/papers", methods=["GET"])
def api_papers():
    status = request.args.get("status")
    return ok(storage.list_papers({"status": status} if status else None))


@app.route("/api/papers", methods=["POST"])
def api_create_paper():
    d = request.get_json(force=True, silent=True) or {}
    if not d.get("title"):
        return fail("试卷标题必填")
    d["created_by"] = (current_user() or {}).get("name")
    try:
        return ok(storage.create_paper(d), "已创建试卷")
    except Exception as e:
        return fail(f"创建失败：{e}")


@app.route("/api/papers/<int:pid>", methods=["GET"])
def api_get_paper(pid):
    p = storage.get_paper(pid)
    if not p:
        return fail("试卷不存在", 404)
    p["questions"] = storage.get_paper_questions(pid)
    return ok(p)


@app.route("/api/papers/<int:pid>", methods=["PUT"])
def api_update_paper(pid):
    d = request.get_json(force=True, silent=True) or {}
    return ok(storage.update_paper(pid, d), "已更新")


@app.route("/api/papers/<int:pid>", methods=["DELETE"])
def api_delete_paper(pid):
    storage.delete_paper(pid)
    return ok(msg="已删除")


@app.route("/api/papers/<int:pid>/questions", methods=["GET"])
def api_paper_questions(pid):
    return ok(storage.get_paper_questions(pid))


@app.route("/api/papers/<int:pid>/questions", methods=["PUT"])
def api_set_paper_questions(pid):
    d = request.get_json(force=True, silent=True) or {}
    items = d.get("items", [])
    try:
        storage.set_paper_questions(pid, items)
        return ok(msg="已组卷")
    except Exception as e:
        return fail(f"组卷失败：{e}")


@app.route("/api/papers/<int:pid>/publish", methods=["POST"])
def api_publish_paper(pid):
    d = request.get_json(force=True, silent=True) or {}
    try:
        p = storage.publish_paper(pid, d.get("open_at"), d.get("close_at"))
        # rep_ids 为空/未传 = 全员广播；否则仅这些客服可见
        storage.set_paper_assignments(pid, d.get("rep_ids") or [])
        return ok(p, "已发布")
    except Exception as e:
        return fail(f"发布失败：{e}")


# ---- 客服考试（登录后） ----
@app.route("/api/exam/papers/available", methods=["GET"])
def api_exam_available():
    u = current_user()
    if not u or not u.get("rep_id"):
        return ok([])
    return ok(storage.list_available_papers(u["rep_id"]))


# ---- 试卷分配（指定客服可见） ----
@app.route("/api/papers/<int:pid>/assignments", methods=["GET"])
def api_get_assignments(pid):
    return ok(storage.get_paper_assignments(pid))


@app.route("/api/papers/<int:pid>/assignments", methods=["PUT"])
def api_set_assignments(pid):
    d = request.get_json(force=True, silent=True) or {}
    try:
        storage.set_paper_assignments(pid, d.get("rep_ids") or [])
        return ok(msg="已更新分配")
    except Exception as e:
        return fail(f"更新失败：{e}")


# ---- 补考 / 单独开启考试（每客服独立时间窗口） ----
@app.route("/api/papers/<int:pid>/makeup", methods=["GET"])
def api_get_makeup(pid):
    u = current_user()
    if not u or u["role"] != "admin":
        return fail("需要管理员权限", 403)
    return ok(storage.list_makeup_assignments(pid))


@app.route("/api/papers/<int:pid>/makeup", methods=["POST"])
def api_set_makeup(pid):
    u = current_user()
    if not u or u["role"] != "admin":
        return fail("需要管理员权限", 403)
    d = request.get_json(force=True, silent=True) or {}
    try:
        storage.set_assignment_window(pid, d.get("rep_id"), d.get("open_at") or None, d.get("due_at") or None)
        return ok(msg="已开启补考窗口")
    except Exception as e:
        return fail(f"操作失败：{e}")


@app.route("/api/papers/<int:pid>/makeup/<rep_id>", methods=["DELETE"])
def api_del_makeup(pid, rep_id):
    u = current_user()
    if not u or u["role"] != "admin":
        return fail("需要管理员权限", 403)
    storage.remove_assignment_window(pid, rep_id)
    return ok(msg="已撤销补考窗口")


# ---- 管理员预览：以某客服身份查看其可见试卷（用于测试客服端） ----
@app.route("/api/admin/preview-papers", methods=["GET"])
def api_admin_preview_papers():
    u = current_user()
    if not u or u.get("role") != "admin":
        return fail("需要管理员权限", 403)
    rep_id = (request.args.get("rep_id") or "").strip()
    if not rep_id:
        return fail("请提供 rep_id")
    return ok(storage.list_available_papers(rep_id))


@app.route("/api/exam/attempt/start", methods=["POST"])
def api_exam_start():
    u = current_user()
    if not u or u["role"] != "rep" or not u["rep_id"]:
        return fail("请先以客服身份登录", 401)
    d = request.get_json(force=True, silent=True) or {}
    try:
        att = storage.start_attempt(int(d.get("paper_id")), u["rep_id"])
    except Exception as e:
        return fail(str(e))
    return ok(att, "已开始考试")


@app.route("/api/exam/attempt/<int:attempt_id>", methods=["GET"])
def api_exam_attempt_detail(attempt_id):
    return ok(storage.get_attempt(attempt_id))


@app.route("/api/exam/attempt/<int:attempt_id>/submit", methods=["POST"])
def api_exam_submit(attempt_id):
    u = current_user()
    if not u or u["role"] != "rep" or not u["rep_id"]:
        return fail("请先以客服身份登录", 401)
    att = storage.get_attempt(attempt_id)
    if not att or att.get("attempt", {}).get("rep_id") != u["rep_id"]:
        return fail("无权提交该考试", 403)
    d = request.get_json(force=True, silent=True) or {}
    try:
        res = storage.submit_attempt(attempt_id, d.get("answers", {}))
    except Exception as e:
        return fail(str(e))
    return ok(res, "已提交")


# ---- 管理员：判分 / 考试管理 ----
@app.route("/api/exam/grading", methods=["GET"])
def api_exam_grading():
    u = current_user()
    if not u or u["role"] != "admin":
        return fail("需要管理员权限", 403)
    return ok(storage.list_pending_grading())


@app.route("/api/exam/grade", methods=["POST"])
def api_exam_grade():
    d = request.get_json(force=True, silent=True) or {}
    try:
        res = storage.grade_essay(int(d["attempt_id"]), int(d["question_id"]),
                                  float(d["score"]), "管理员")
    except Exception as e:
        return fail(str(e))
    return ok(res, "已判分")


@app.route("/api/exam/attempts", methods=["GET"])
def api_exam_attempts():
    u = current_user()
    if not u or u["role"] != "admin":
        return fail("需要管理员权限", 403)
    filters = {"paper_id": request.args.get("paper_id"),
               "rep_id": request.args.get("rep_id"), "status": request.args.get("status")}
    filters = {k: v for k, v in filters.items() if v}
    return ok(storage.list_attempts(filters))


@app.route("/api/exam/my-history", methods=["GET"])
def api_exam_my_history():
    """客服端：返回本人参加过的全部考试（含已关闭试卷），每条带对应 session_id。"""
    u = current_user()
    if not u or not u.get("rep_id"):
        return fail("未登录", 401)
    return ok(storage.my_exam_history(u["rep_id"]))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"[看板] 存储后端 = {BACKEND}")
    print(f"[看板] 访问地址 = http://127.0.0.1:{port}")
    # debug=False：关闭自动重载，避免监控目录文件变化导致服务重启/卡死；
    # 本地长期使用更稳定。改代码后需手动重启。
    app.run(host="0.0.0.0", port=port, debug=False)
