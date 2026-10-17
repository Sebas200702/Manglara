"""Genera y verifica el hash scrypt para ADMIN_PASSWORD_HASH.

Uso:
    python scripts/hash_password.py                # pregunta por la clave
    python scripts/hash_password.py --verify       # valida lo que hay en .env

Escribe/actualiza ADMIN_PASSWORD_HASH en .env y elimina una
ADMIN_PASSWORD= de ese mismo .env, para que quede en un solo estado.
"""

import argparse
import getpass
import hashlib
import hmac
import os
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Parámetros scrypt: OWASP recomienda N=2^16 (64 MiB), r=8, p=1.
# maxmem se fija completo en ambos lados porque el límite por defecto de
# OpenSSL (32 MiB) es menor que la memoria real que pide N=2^16.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 1 << 16, 8, 1
SCRYPT_MAXMEM = 128 * 1024 * 1024


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
        dklen=32, maxmem=SCRYPT_MAXMEM,
    )
    return f"scrypt:{SCRYPT_N}:{SCRYPT_R}:{SCRYPT_P}:{salt.hex()}:{digest.hex()}"


def verify(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_hex, digest_hex = stored.split(":")
        expected = bytes.fromhex(digest_hex)
        candidate = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p), dklen=len(expected), maxmem=SCRYPT_MAXMEM,
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(candidate, expected)


def upsert_env_line(env_path: Path, key: str, value: str) -> None:
    """Reemplaza KEY=... o la añade al final. Conserva el resto."""
    text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    line = f"{key}={value}"
    if pattern.search(text):
        text = pattern.sub(line, count=1)
    else:
        text = (text.rstrip("\n") + ("\n" if text else "")) + line + "\n"
    env_path.write_text(text, encoding="utf-8")


def drop_env_line(env_path: Path, key: str) -> None:
    if not env_path.exists():
        return
    text = env_path.read_text(encoding="utf-8")
    text = re.sub(rf"^#?{re.escape(key)}=.*\n?", "", text, flags=re.MULTILINE)
    env_path.write_text(text, encoding="utf-8")


def read_env_hash() -> str | None:
    env = ROOT / ".env"
    if not env.exists():
        return None
    m = re.search(r"^ADMIN_PASSWORD_HASH=(.+)$", env.read_text(encoding="utf-8"), re.MULTILINE)
    return m.group(1).strip() if m else None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verify", action="store_true", help="validar ADMIN_PASSWORD_HASH del .env")
    args = ap.parse_args()

    if args.verify:
        stored = read_env_hash()
        if not stored:
            print("No hay ADMIN_PASSWORD_HASH en .env")
            return
        pw = getpass.getpass("Clave: ")
        print("OK ✔" if verify(pw, stored) else "Clave INCORRECTA ✘")
        return

    pw = getpass.getpass("Nueva clave del gestor: ")
    if len(pw) < 8:
        sys.exit("Mínimo 8 caracteres.")
    if pw != getpass.getpass("Repetir: "):
        sys.exit("No coinciden.")

    env = ROOT / ".env"
    upsert_env_line(env, "ADMIN_PASSWORD_HASH", hash_password(pw))
    drop_env_line(env, "ADMIN_PASSWORD")
    drop_env_line(env, "SESSION_SECRET")  # se deriva de la clave; la clave cambió
    print(f"ADMIN_PASSWORD_HASH actualizado en {env}")
    print("La clave anterior ha quedado invalidada en esta máquina.")


if __name__ == "__main__":
    main()
