import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from academic.view_context import require_view, view_key

CONTEXT = {'issuer': 'https://moodle.example', 'clientId': 'client', 'deploymentId': '1',
           'courseId': '2', 'resourceId': '3', 'lessonCode': 'HV-M1-L1',
           'sourceVersion': '2026-10-28', 'mode': 'learner'}


class ViewContextTest(unittest.TestCase):
    def test_view_is_bound_to_resource_course_version_and_role(self):
        key = view_key(CONTEXT)
        require_view(CONTEXT, key)
        for field, value in [('resourceId', '9'), ('courseId', '7'), ('lessonCode', 'HV-M5-L1'),
                             ('sourceVersion', 'changed'), ('mode', 'instructor')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                require_view({**CONTEXT, field: value}, key)

    def test_absent_view_is_rejected(self):
        for key in [None, '', 'untrusted', '0' * 64]:
            with self.assertRaises(ValueError):
                require_view(CONTEXT, key)

    def test_metadata_checksum_is_not_a_session_credential(self):
        self.assertEqual(view_key(CONTEXT), view_key({**CONTEXT, 'subject': 'different-user'}))


if __name__ == '__main__':
    unittest.main()
