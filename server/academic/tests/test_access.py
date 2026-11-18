import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")
os.environ.setdefault("SUPABASE_URL", "https://example.invalid")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-key-not-used")
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from academic_app import app
from academic.view_context import view_key

ORIGIN = "https://tutor.academia.localhost:8443"
CONTEXT = {"issuer": "https://aula.academia.localhost:8443", "clientId": "client", "deploymentId": "1",
           "courseId": "2", "resourceId": "3", "lessonCode": "HV-M1-L1", "sourceVersion": "2026-10-28",
           "subject": "fictional", "mode": "learner"}


COOKIE_HEADER = "__Host-academia_session=" + "a" * 64


class AcademicAccessTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"ACADEMIC_ORIGIN": ORIGIN, "ACADEMIC_PARENT_ORIGIN": CONTEXT["issuer"]})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(app)

    def test_context_without_cookie_fails_before_gateway(self):
        with patch("academic.routes.gateway_call", new_callable=AsyncMock) as gateway:
            response = self.client.get("/academic/api/context")
            self.assertEqual(response.status_code, 401)
            gateway.assert_not_called()

    def test_launch_rejects_other_origin_before_exchange(self):
        with patch("academic.routes.gateway_call", new_callable=AsyncMock) as gateway:
            response = self.client.post("/academic/launch", data={"code": "a" * 64}, headers={"origin": "https://untrusted.invalid"})
            self.assertEqual(response.status_code, 403)
            gateway.assert_not_called()

    def test_launch_sets_host_only_secure_httponly_cookie(self):
        with patch("academic.routes.gateway_call", new_callable=AsyncMock, return_value={"token": "b" * 64, "academic": CONTEXT}):
            response = self.client.post("/academic/launch", data={"code": "a" * 64}, headers={"origin": ORIGIN}, follow_redirects=False)
        self.assertEqual(response.status_code, 303)
        cookie = response.headers["set-cookie"]
        self.assertIn("__Host-academia_session=", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Secure", cookie)
        self.assertNotIn("Domain=", cookie)
        self.assertEqual(response.headers["location"], "/academic?view=" + view_key(CONTEXT))
        self.assertNotIn("b" * 64, response.headers["location"])

    def test_cookie_changed_by_another_lesson_is_denied_before_model(self):
        other = {**CONTEXT, "lessonCode": "HV-M5-L1", "resourceId": "15"}
        with patch("academic.routes.gateway_call", new_callable=AsyncMock, return_value=other):
            response = self.client.get("/academic/api/context?view=" + view_key(CONTEXT), headers={"cookie": COOKIE_HEADER})
            self.assertEqual(response.status_code, 401)
        with patch("academic.socket.gateway_call", new_callable=AsyncMock, return_value=other) as gateway, patch("academic.socket.GeminiLiveClient") as model:
            with self.assertRaises(WebSocketDisconnect):
                with self.client.websocket_connect("/academic/ws/voice?view=" + view_key(CONTEXT), headers={"origin": ORIGIN, "cookie": COOKIE_HEADER}):
                    pass
            self.assertEqual(gateway.await_count, 1)
            model.assert_not_called()

    def test_matching_module_five_view_returns_only_public_context(self):
        other = {**CONTEXT, "lessonCode": "HV-M5-L1", "resourceId": "15"}
        with patch("academic.routes.gateway_call", new_callable=AsyncMock, return_value=other):
            response = self.client.get("/academic/api/context?view=" + view_key(other), headers={"cookie": COOKIE_HEADER})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["lessonCode"], "HV-M5-L1")
        self.assertEqual(response.json()["lessonTitle"], "HV-M5-L1")
        self.assertNotIn("subject", response.json())

    def test_socket_requires_origin_and_cookie_before_model(self):
        with patch("academic.socket.GeminiLiveClient") as model:
            for headers in ({"origin": ORIGIN}, {"origin": "https://untrusted.invalid", "cookie": "__Host-academia_session=" + "a" * 64}):
                with self.assertRaises(WebSocketDisconnect):
                    with self.client.websocket_connect("/academic/ws/voice", headers=headers):
                        pass
            model.assert_not_called()

    def test_academic_server_does_not_expose_event_documents(self):
        self.assertEqual(self.client.get("/api/documents").status_code, 404)


if __name__ == "__main__":
    unittest.main()
