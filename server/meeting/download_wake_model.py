"""Descarga el modelo español local de Vosk una vez (desarrollo/deploy)."""

from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import urlretrieve
from zipfile import ZipFile


MODEL_NAME = "vosk-model-small-es-0.42"
MODEL_URL = f"https://alphacephei.com/vosk/models/{MODEL_NAME}.zip"
DEST = Path(__file__).resolve().parents[1] / "models" / MODEL_NAME


def main():
    if (DEST / "am" / "final.mdl").exists():
        print(f"Modelo ya instalado: {DEST}")
        return
    DEST.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=DEST.parent) as tmp:
        archive = Path(tmp) / "model.zip"
        urlretrieve(MODEL_URL, archive)
        with ZipFile(archive) as zip_file:
            for item in zip_file.infolist():
                path = Path(item.filename)
                if not path.parts or path.parts[0] != MODEL_NAME or ".." in path.parts:
                    raise ValueError("El archivo del modelo contiene una ruta inesperada")
            zip_file.extractall(tmp)
        extracted = Path(tmp) / MODEL_NAME
        if not (extracted / "am" / "final.mdl").exists():
            raise ValueError("El archivo del modelo está incompleto")
        extracted.rename(DEST)
    print(f"Modelo instalado: {DEST}")


if __name__ == "__main__":
    main()
