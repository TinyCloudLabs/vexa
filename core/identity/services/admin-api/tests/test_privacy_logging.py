import subprocess
import sys
from pathlib import Path


def test_lazy_admin_app_configures_privacy_logging_before_construction():
    source = Path(__file__).resolve().parents[1] / "src"
    script = r"""
import logging, sys, types
sys.path.insert(0, sys.argv[1])
import admin_api.__main__ as entrypoint
def build_production_app():
    try:
        raise RuntimeError("https://admin.example/canary?token=ADMIN_TOKEN_CANARY")
    except RuntimeError:
        logging.getLogger("admin.child").warning(
            "ADMIN_NAME_CANARY", exc_info=True,
            extra={"token": "ADMIN_EXTRA_TOKEN_CANARY",
                   "fields": {"message": "ADMIN_EXTRA_TEXT_CANARY"}},
        )
    return object()
entrypoint.build_production_app = build_production_app
entrypoint.__getattr__("app")
assert logging.getLogger("uvicorn.access").disabled
captured = {}
sys.modules["uvicorn"] = types.SimpleNamespace(
    run=lambda *args, **kwargs: captured.update(args=args, kwargs=kwargs)
)
entrypoint.main()
from admin_api.obs import LOG_CONFIG
assert captured["kwargs"]["log_config"] == LOG_CONFIG
assert captured["kwargs"]["access_log"] is False
"""
    proc = subprocess.run(
        [sys.executable, "-c", script, str(source)],
        capture_output=True, text=True, timeout=15,
    )
    output = proc.stdout + proc.stderr
    assert proc.returncode == 0, output
    for canary in (
        "admin.example", "ADMIN_TOKEN_CANARY", "ADMIN_NAME_CANARY",
        "ADMIN_EXTRA_TOKEN_CANARY", "ADMIN_EXTRA_TEXT_CANARY", "Traceback", "RuntimeError",
    ):
        assert canary not in output
    assert '"event":"log_event"' in output


def test_admin_database_exception_handler_returns_generic_error_and_drops_sql_values(caplog):
    from fastapi.testclient import TestClient
    from sqlalchemy.exc import StatementError

    from admin_api.app.main import create_app

    app = create_app()

    @app.get("/test/database-error")
    async def database_error():
        raise StatementError(
            "TC965_SQL_MESSAGE_CANARY",
            "SELECT :value",
            {"value": "TC965_SQL_PARAM_CANARY"},
            RuntimeError("TC965_SQL_ORIGINAL_CANARY"),
        )

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/test/database-error")
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal Server Error"}
    assert "TC965_SQL_MESSAGE_CANARY" not in caplog.text
    assert "TC965_SQL_PARAM_CANARY" not in caplog.text
    assert "TC965_SQL_ORIGINAL_CANARY" not in caplog.text
    assert "unhandled request exception" in caplog.text
