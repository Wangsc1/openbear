#!/usr/bin/env python3
"""Check whether the pre-upgrade Web session remains accepted after upgrade."""
import argparse
import asyncio
import json
import pathlib

import aiohttp

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--session-file", type=pathlib.Path, required=True)
parser.add_argument("--output", type=pathlib.Path, required=True)
args = parser.parse_args()


async def main():
    token = args.session_file.read_text(encoding="utf-8").strip()
    assert token
    base = f"http://127.0.0.1:{args.port}"
    headers = {"Cookie": f"openbear_web_session={token}"}
    async with aiohttp.ClientSession(headers=headers) as session:
        response = await session.get(base + "/api/auth/session")
        body = await response.text()
        report = {"status": response.status, "oldSessionSurvived": response.status == 200}
        if response.status == 200:
            payload = json.loads(body)
            report["chatId"] = int(payload["chatId"])
            assert report["chatId"] == 123456789
        elif response.status not in {401, 403}:
            raise AssertionError((response.status, body))
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


asyncio.run(main())
