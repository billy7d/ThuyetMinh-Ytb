"""Chuyển model dịch (OPUS-MT en-vi hoặc vinai-translate-en2vi, đã cài và kiểm tra hash theo manifest) sang CTranslate2.

Bản CTranslate2 chạy được trên GPU NVIDIA (int8_float16) và CPU (int8), nhanh hơn PyTorch CPU 4–5 lần.
Không tải gì từ mạng; chỉ đọc model local. Ghi vietdub-conversion.json để worker từ chối bản chuyển đổi lệch nguồn.

Dùng (venv runtime):
  python runtime/convert_translation_ct2.py --source E:/VietDub-AI/models/translation/vinai-translate-en2vi-v2 \
      --output E:/VietDub-AI/models/translation/vinai-translate-en2vi-v2-ct2 --quantization int8_float16
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

SOURCE_WEIGHTS = "pytorch_model.bin"
METADATA = "vietdub-conversion.json"
# File tokenizer của từng kiểu model; chỉ chép những file có thật trong thư mục nguồn.
TOKENIZER_FILES = ["source.spm", "target.spm", "vocab.json", "tokenizer_config.json", "sentencepiece.bpe.model"]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--quantization", default="float16", help="kiểu lưu; kiểu tính chọn lúc nạp (int8_float16/int8)")
    args = parser.parse_args()

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    import ctranslate2
    from ctranslate2.converters import TransformersConverter

    source = Path(args.source).resolve()
    output = Path(args.output).resolve()
    weights = source / SOURCE_WEIGHTS
    if not weights.is_file():
        raise SystemExit(f"thiếu {weights}")
    copy_files = [name for name in TOKENIZER_FILES if (source / name).is_file()]
    TransformersConverter(str(source), copy_files=copy_files, load_as_float16=False).convert(
        str(output), quantization=args.quantization, force=True
    )
    metadata = {
        "sourceFile": SOURCE_WEIGHTS,
        "sourceSizeBytes": weights.stat().st_size,
        "sourceSha256": sha256(weights),
        "quantization": args.quantization,
        "ctranslate2Version": ctranslate2.__version__,
        "convertedAt": datetime.now(timezone.utc).isoformat(),
    }
    (output / METADATA).write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output), **metadata}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
