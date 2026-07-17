#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一次性迁移：把本地 SQLite 的「考题体系 + 资料库」迁到 Neon / Postgres。

不迁（按用户决定，均为测试/业务数据）：
  - 客服：cs_reps / accounts
  - 考试记录：exam_sessions / exam_results / exam_attempts / exam_answers / exam_assignments
  - 积分：points_account / points_log

迁移范围（考题体系 + 资料库）：
  knowledge_dimensions, learning_materials, questions, question_attachments,
  exam_papers, paper_questions, exam_question_bank, exam_question_dimensions,
  question_bank_meta, material_dimensions

用法（连接串只通过环境变量传入，绝不写进本文件 / 提交）：
  SOURCE_DB=data/exam.db DATABASE_URL="postgres://user:pass@host/db" python migrate_to_neon.py
"""
import os
import sqlite3
import sys

try:
    import psycopg2
    from psycopg2.extras import DictCursor
except Exception:
    print("需要 psycopg2-binary：pip install psycopg2-binary")
    sys.exit(1)

SOURCE_DB = os.environ.get(
    "SOURCE_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "exam.db"),
)
DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    print("缺少环境变量 DATABASE_URL（Neon 连接串）")
    sys.exit(1)
if not os.path.exists(SOURCE_DB):
    print("源库不存在:", SOURCE_DB)
    sys.exit(1)

# 插入顺序需满足外键依赖
TABLES = [
    "knowledge_dimensions",
    "learning_materials",
    "questions",
    "question_attachments",
    "exam_papers",
    "paper_questions",
    "exam_question_bank",
    "exam_question_dimensions",
    "question_bank_meta",
    "material_dimensions",
]
# 含 SERIAL 主键、迁移后需重置序列的表
SERIAL_PK = {
    "knowledge_dimensions": "dim_id",
    "learning_materials": "material_id",
    "questions": "question_id",
    "question_attachments": "att_id",
    "exam_papers": "paper_id",
}

src = sqlite3.connect(SOURCE_DB)
src.row_factory = sqlite3.Row
pg = psycopg2.connect(DATABASE_URL, cursor_factory=DictCursor)
pg.autocommit = False
cur = pg.cursor()


def pg_columns(tbl):
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name=%s ORDER BY ordinal_position",
        (tbl,),
    )
    return [r["column_name"] for r in cur.fetchall()]


def norm(v):
    # SQLite 存 bool 为 0/1，Postgres INTEGER 列不接受布尔字面量
    return int(v) if isinstance(v, bool) else v


total = 0
for tbl in TABLES:
    cols = pg_columns(tbl)
    if not cols:
        print(f"! 跳过（目标无此表）: {tbl}")
        continue
    rows = src.execute(f"SELECT * FROM {tbl}").fetchall()
    n = 0
    for r in rows:
        use_cols = [c for c in cols if c in r.keys()]
        if not use_cols:
            continue
        vals = [norm(r[c]) for c in use_cols]
        ph = ", ".join(["%s"] * len(use_cols))
        sql = (
            f"INSERT INTO {tbl} ({', '.join(use_cols)}) "
            f"VALUES ({ph}) ON CONFLICT DO NOTHING"
        )
        cur.execute(sql, vals)
        n += 1
    pg.commit()
    total += n
    print(f"  {tbl}: {n} 行")

# 重置 SERIAL 序列，避免后续自增主键与已插入的 ID 冲突
for tbl, pk in SERIAL_PK.items():
    cur.execute(
        f"SELECT setval(pg_get_serial_sequence(%s, %s), "
        f"COALESCE((SELECT MAX({pk}) FROM {tbl}), 1), true)",
        (tbl, pk),
    )
pg.commit()

print(f"迁移完成，共 {total} 行。Postgres 序列已重置。")
cur.close()
pg.close()
src.close()
