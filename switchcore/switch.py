"""Mock payment switch. Legacy behaviour by default; each bug flag is one small `if`."""
from __future__ import annotations
from shared.schemas import Account
from switchcore import iso

DUP_WINDOW = 60   # configured duplicate window, seconds


class Switch:
    def __init__(self, name: str, bugs: set[str] | None = None):
        self.name = name
        self.bugs = set(bugs or ())
        self.accounts: dict[str, Account] = {}
        self._bal: dict[str, int] = {}
        # (pan, stan) -> {"amount", "time", "reversed"} for approved purchases/auths
        self.postings: dict[tuple[str, str], dict] = {}

    def load_accounts(self, accounts: list[Account]) -> None:
        for a in accounts:
            self.accounts[a.pan] = a
            self._bal[a.pan] = a.balance_cents

    def balances(self) -> dict[str, int]:
        return dict(self._bal)

    def handle(self, raw: bytes) -> bytes:
        f = iso.parse(raw)
        code = self._reversal(f) if f["t"] == "0400" else self._purchase(f)
        return iso.build_response(f, code)

    def _purchase(self, f: dict[str, str]) -> str:
        pan, stan, amount = f["2"], f["11"], int(f["4"])
        now = iso.txn_time(f)
        pin_ok = "PIN=OK" in f.get("48", "")
        glitch = "GLITCH=1" in f.get("48", "")

        acct = self.accounts.get(pan)
        if acct is None:
            return "14"
        if acct.status == "blocked":
            return "62"
        expiry, txn_yymm = f.get("14", acct.expiry_yymm), now.strftime("%y%m")
        if expiry < txn_yymm or ("expiry_month_off_by_one" in self.bugs and expiry == txn_yymm):
            return "54"
        if not pin_ok and not ("pin_ignored_swipe" in self.bugs and f.get("22") == "021"):
            return "55"
        if glitch and "glitch_fail_open" not in self.bugs:   # fail-open: carries on and approves
            return "96"

        prev = self.postings.get((pan, stan))
        if prev:
            gap_s = (now - prev["time"]).total_seconds()
            window_s = DUP_WINDOW
            if "dup_window_units" in self.bugs:
                window_s = DUP_WINDOW / 1000   # config value 60 intended as seconds, read as milliseconds
            same_amount = prev["amount"] == amount or "dup_key_ignores_amount" in self.bugs
            if same_amount and gap_s <= window_s:
                return "94"

        bal = self._bal[pan]
        if bal < amount or ("nsf_exact_balance" in self.bugs and bal <= amount):
            return "51"
        self._bal[pan] = bal - amount
        self.postings[(pan, stan)] = {"amount": amount, "time": now, "reversed": False}
        return "00"

    def _reversal(self, f: dict[str, str]) -> str:
        orig = self.postings.get((f["2"], f.get("37", "")[-6:]))
        if orig is None:
            return "25"
        if orig["reversed"] and "reversal_double_credit" not in self.bugs:
            return "94"
        if "reversal_no_credit" not in self.bugs:
            self._bal[f["2"]] += orig["amount"]
        orig["reversed"] = True
        return "00"
