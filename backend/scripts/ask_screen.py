from __future__ import annotations

import argparse
import json
import sys
from typing import Any
from urllib import error, request
from urllib.parse import urlparse


LOCAL_BYPASS_HEADER = "X-Inksight-Local-Bypass"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ask an LLM question and show the answer as a 60-second pixel cat companion on the InkSight screen.",
    )
    parser.add_argument("base_url", help="Backend base URL, for example http://127.0.0.1:8080")
    parser.add_argument("mac", help="Device MAC address")
    parser.add_argument("alert_token", help="Device alert token")
    parser.add_argument("question", nargs="*", help="Question text")
    parser.add_argument("--answer", default="", help="Skip the LLM call and push this answer text directly")
    parser.add_argument("--provider", default="", help="Optional LLM provider override, for example openai_compat")
    parser.add_argument("--model", default="", help="Optional LLM model override")
    parser.add_argument("--api-key", default="", help="Optional API key override")
    parser.add_argument("--llm-base-url", default="", help="Optional OpenAI-compatible base URL, for example http://127.0.0.1:11434/v1")
    parser.add_argument("--sender", default="PIXEL CAT", help='Sender label shown above the answer (default: "PIXEL CAT")')
    parser.add_argument("--level", default="info", choices=["info", "critical"], help="Alert level")
    parser.add_argument("--cat", action="store_true", help="Deprecated alias; the cat companion is now the default mode")
    parser.add_argument(
        "--cat-action",
        default="",
        choices=["", "think", "wave", "cheer", "comfort", "pounce", "nap"],
        help="Optional cat action override",
    )
    parser.add_argument(
        "--cat-outfit",
        default="",
        choices=["", "travel", "science", "food", "fitness", "business", "art", "comfort", "general"],
        help="Optional cat outfit override",
    )
    parser.add_argument("--interactive", action="store_true", help="Start an interactive terminal chat session")
    parser.add_argument("--timeout", default=30.0, type=float, help="HTTP timeout in seconds")
    return parser.parse_args()


def _post_json(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    req = request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body) if body else {"ok": True}


def _is_loopback_base(base_url: str) -> bool:
    try:
        host = (urlparse(base_url).hostname or "").strip().lower()
    except ValueError:
        return False
    return host in {"127.0.0.1", "localhost", "::1"}


def _build_request(args: argparse.Namespace, question: str, answer_override: str) -> tuple[str, dict[str, str], dict[str, Any]]:
    url = f"{args.base_url.rstrip('/')}/api/device/{args.mac}/ask"
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "X-Agent-Token": args.alert_token,
    }
    if _is_loopback_base(args.base_url):
        headers[LOCAL_BYPASS_HEADER] = "1"
    payload: dict[str, Any] = {
        "question": question,
        "answer": answer_override,
        "sender": args.sender,
        "level": args.level,
        "companion": "cat",
    }
    if args.cat_action:
        payload["cat_action"] = args.cat_action
    if args.cat_outfit:
        payload["cat_outfit"] = args.cat_outfit
    if args.provider:
        payload["provider"] = args.provider
    if args.model:
        payload["model"] = args.model
    if args.api_key:
        payload["api_key"] = args.api_key
    if args.llm_base_url:
        payload["llm_base_url"] = args.llm_base_url
    return url, headers, payload


def _send_once(args: argparse.Namespace, question: str, answer_override: str) -> tuple[int, dict[str, Any] | None]:
    url, headers, payload = _build_request(args, question, answer_override)

    if question:
        print(f"Asking: {question}")
    elif answer_override:
        print(f"Pushing provided answer: {answer_override}")

    try:
        result = _post_json(url, headers, payload, args.timeout)
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"Failed: HTTP {exc.code} {body}", file=sys.stderr)
        return 1, None
    except Exception as exc:
        print(f"Failed: {exc}", file=sys.stderr)
        return 1, None

    return 0, result


def _print_result(result: dict[str, Any], *, interactive: bool = False) -> None:
    answer = str(result.get("answer") or "").strip()
    if answer:
        prefix = "cat" if interactive else "Answer"
        if interactive:
            print(f"cat> {answer}")
        else:
            print(f"{prefix}: {answer}")
    if not interactive:
        print("Sent. The device should show the pixel cat companion for about 60 seconds, then restore the previous screen.")
    cat_action = str(result.get("cat_action") or "").strip()
    if cat_action:
        label = "action" if interactive else "Cat action"
        print(f"{label}: {cat_action}")
    cat_outfit = str(result.get("cat_outfit") or "").strip()
    if cat_outfit:
        label = "outfit" if interactive else "Cat outfit"
        print(f"{label}: {cat_outfit}")
    if not interactive:
        print(f"Server response: {result}")


def _run_interactive(args: argparse.Namespace) -> int:
    print("InkSight Pixel Cat chat started.")
    print(f"Device: {args.mac}")
    print("Type your question and press Enter.")
    print("Commands: /help  /answer <text>  /quit")
    while True:
        try:
            raw = input("you> ")
        except EOFError:
            print()
            break
        except KeyboardInterrupt:
            print("\nBye.")
            return 0

        text = str(raw or "").strip()
        if not text:
            continue
        if text.lower() in {"/quit", "/exit", "quit", "exit"}:
            print("Bye.")
            return 0
        if text.lower() == "/help":
            print("Ask normally to send a cat reply to the screen.")
            print("/answer <text>  push a fixed sentence without calling the model")
            print("/quit           exit the chat")
            continue

        answer_override = ""
        question = text
        if text.lower().startswith("/answer "):
            answer_override = text[8:].strip()
            question = ""
            if not answer_override:
                print("usage: /answer <text>")
                continue

        status, result = _send_once(args, question, answer_override)
        if status != 0 or not result:
            continue
        _print_result(result, interactive=True)
    return 0


def main() -> int:
    args = _parse_args()
    question = " ".join(args.question).strip()
    answer_override = str(args.answer or "").strip()
    interactive = args.interactive or (not question and not answer_override)
    if interactive:
        return _run_interactive(args)

    status, result = _send_once(args, question, answer_override)
    if status != 0 or not result:
        return status
    _print_result(result, interactive=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
