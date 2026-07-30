# gunicorn 进程配置（考试看板 Flask 后端）
# 原配置 --workers 1 单进程单线程，并发=1，多人同时操作会串行排队。
# 改为 gthread 多线程：Starter 档(0.5 vCPU)按 2*CPU+1=2 worker × 4 线程 = 8 并发请求；
# 考试请求是 I/O 密集(SQL 等待)，多线程利用率高。
# 若升 Standard(2GB/1核) 可改为 --workers 3 --threads 4 (=12 并发)。
web: gunicorn server:app --bind 0.0.0.0:$PORT --workers 2 --worker-class gthread --threads 4 --timeout 120 --max-requests 1000 --max-requests-jitter 100
