import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from academic.curriculum import academic_prompt, lesson_source

ROOT = Path(os.environ.get('ACADEMIC_CONTENT_ROOT', Path(__file__).resolve().parents[3] / 'cartillas'))
VERSION = '2026-10-28'


class CurriculumTest(unittest.TestCase):
    def test_all_fifteen_lessons_have_distinct_isolated_sources(self):
        sources = []
        for module in range(1, 6):
            for lesson in range(1, 4):
                code = f'HV-M{module}-L{lesson}'
                with self.subTest(code=code):
                    source = lesson_source({'lessonCode': code, 'sourceVersion': VERSION}, ROOT)
                    self.assertRegex(source.splitlines()[0], rf'^Lección\s+{lesson}\.')
                    self.assertEqual(len(re.findall(r'^Lección\s+\d+\.', source, re.MULTILINE)), 1)
                    self.assertGreater(len(source), 1000)
                    sources.append(source)
        self.assertEqual(len(set(sources)), 15)

    def test_unknown_lesson_and_version_fail_closed(self):
        for code, version in [('../../.env', VERSION), ('HV-M6-L1', VERSION), ('HV-M1-L4', VERSION), ('HV-M1-L1', 'old')]:
            with self.subTest(code=code, version=version), self.assertRaises(ValueError):
                lesson_source({'lessonCode': code, 'sourceVersion': version}, ROOT)

    def test_tampered_source_fails_before_docx_parsing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'cartillas'
            root.mkdir()
            shutil.copyfile(ROOT.parent / 'academic-source-lock.json', Path(folder) / 'academic-source-lock.json')
            (root / '3_Modulo2_HabilidadesVerdes.docx').write_bytes(b'contenido cambiado')
            with self.assertRaisesRegex(ValueError, 'ACADEMIC_SOURCE_VERSION_UNAVAILABLE'):
                lesson_source({'lessonCode': 'HV-M2-L1', 'sourceVersion': VERSION}, root)

    def test_prompt_names_exact_module_and_academic_context(self):
        for module in range(1, 6):
            academic = {'lessonCode': f'HV-M{module}-L1', 'sourceVersion': VERSION}
            prompt = academic_prompt(academic, 'MATERIAL_PRUEBA')
            self.assertIn(f'{module+1}_Modulo{module}_HabilidadesVerdes.docx', prompt)
            self.assertIn('MATERIAL_PRUEBA', prompt)
            self.assertIn(academic['lessonCode'], prompt)
            self.assertIn('No asignes notas', prompt)


if __name__ == '__main__':
    unittest.main()
