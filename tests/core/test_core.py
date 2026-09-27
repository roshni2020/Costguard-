from shared.schemas import Account, Step, TestCase
from switchcore import iso
from switchcore.bugs import BUG_LIBRARY, HOLDOUT_BUG, TRAINING_BUGS
from switchcore.dataset import load_replay_cases
from switchcore.demo import demo_duplicate_case
from switchcore.engine import close_pool, run_case
from switchcore.switch import Switch

PAN = "4111111111111111"


def sw(bugs=(), balance=100_000, expiry="2912", status="active"):
    s = Switch("t", set(bugs))
    s.load_accounts([Account(pan=PAN, balance_cents=balance, expiry_yymm=expiry, status=status)])
    return s


def send(s, mti="0200", amount=25000, stan="000123", off=0.0, pan=PAN, orig=None, expiry="2912", **kw):
    raw, _ = iso.build_request(Step(mti=mti, pan=pan, amount_cents=amount, stan=stan, at_offset_s=off,
                                    original_stan=orig, **kw), expiry)
    return iso.parse(s.handle(raw))["39"]


def test_iso_roundtrip_and_clock():
    raw, f = iso.build_request(Step(mti="0400", pan=PAN, amount_cents=25000, stan="000124", at_offset_s=5, original_stan="000123"))
    back = iso.parse(raw)
    assert back == f and f["3"] == "200000" and f["37"] == "000000000123" and f["7"] == "0927120005"
    resp = iso.parse(iso.build_response(back, "00"))
    assert resp["t"] == "0410" and resp["39"] == "00"


def test_legacy_check_order():
    assert send(sw(), pan="4000000000000002") == "14"
    assert send(sw(status="blocked")) == "62"
    assert send(sw(), expiry="2608") == "54"
    assert send(sw(), pin_ok=False) == "55"
    assert send(sw(), force_glitch=True) == "96"
    assert send(sw(balance=100)) == "51"
    assert send(sw(balance=25000)) == "00"


def test_duplicates():
    s = sw(); assert send(s) == "00"; assert send(s, off=5) == "94"; assert send(s, off=70) == "00"
    s = sw({"dup_window_units"}); assert send(s) == "00"; assert send(s, off=0.5) == "94"; assert send(s, off=5) == "00"
    s = sw(); send(s); assert send(s, amount=999, off=5) == "00"
    s = sw({"dup_key_ignores_amount"}); send(s); assert send(s, amount=999, off=5) == "94"


def test_reversals_and_bugs():
    s = sw(); send(s)
    assert send(s, "0400", stan="000124", off=1, orig="000123") == "00" and s.balances()[PAN] == 100_000
    assert send(s, "0400", stan="000125", off=2, orig="000123") == "94"
    assert send(s, "0400", stan="000126", off=3, orig="999999") == "25"
    s = sw({"reversal_no_credit"}); send(s); send(s, "0400", stan="000124", orig="000123"); assert s.balances()[PAN] == 75_000
    s = sw({"reversal_double_credit"}); send(s)
    assert send(s, "0400", stan="000124", orig="000123") == send(s, "0400", stan="000125", orig="000123") == "00"
    assert s.balances()[PAN] == 125_000
    assert send(sw({"nsf_exact_balance"}, balance=25000)) == "51"
    assert send(sw({"expiry_month_off_by_one"}), expiry="2609") == "54"
    s = sw({"glitch_fail_open"}); assert send(s, force_glitch=True) == "00" and s.balances()[PAN] == 75_000
    assert send(sw({"pin_ignored_swipe"}), pin_ok=False, entry_mode="swipe") == "00"


def test_engine_demo_regression_both_transports():
    for transport in ("inproc", "tcp"):
        r = run_case(demo_duplicate_case("r"), {"dup_window_units"}, transport=transport)
        assert r.verdict == "regression", r
        assert [s.old_a_code for s in r.steps] == ["00", "94"] and [s.new_code for s in r.steps] == ["00", "00"]
        assert r.balance_delta_cents["old_a"][PAN] == -25000 and r.balance_delta_cents["new"][PAN] == -50000
    close_pool()


def test_engine_pass_both_wrong_error():
    case = demo_duplicate_case("r")
    assert run_case(case, set()).verdict == "pass"
    wrong = case.model_copy(update={"expected_codes": ["00", "00"]})
    assert run_case(wrong, set()).verdict == "both_wrong"
    bad = case.model_copy(update={"expected_codes": ["00"]})
    assert run_case(bad, set()).verdict == "error"
    case.check_script = "print('hi')"
    assert run_case(case, set()).check_output == "skipped: not in sandbox"


def test_replay_fake_dataset(monkeypatch):
    monkeypatch.setenv("TABFORMER_CSV", "does-not-exist.csv")
    cases = load_replay_cases("r", 300)
    assert 250 <= len(cases) <= 300
    verdicts = [run_case(c, set()).verdict for c in cases]
    assert set(verdicts) == {"pass"}, "legacy switch must agree with dataset-derived expectations"
    assert any(run_case(c, {"dup_window_units"}).verdict == "regression" for c in cases)


def test_bug_library():
    assert len(BUG_LIBRARY) == 8 and HOLDOUT_BUG == "dup_window_units" and HOLDOUT_BUG not in TRAINING_BUGS


def test_failing_check_script_is_never_a_pass(monkeypatch):
    monkeypatch.setenv("SWITCHPROOF_IN_SANDBOX", "1")
    monkeypatch.delenv("SANDBOX_POOL", raising=False)
    case = demo_duplicate_case("r").model_copy(update={"check_script": "assert False, 'agent check failed'"})
    r = run_case(case, set())                      # switches agree -> would be `pass` without the check
    assert r.verdict == "error" and "check_script failed" in r.error and r.check_output.startswith("exit=1")
    ok = demo_duplicate_case("r").model_copy(update={"check_script": "print('fine')"})
    assert run_case(ok, set()).verdict == "pass"


def test_replay_source_is_recorded(monkeypatch):
    from switchcore import dataset
    monkeypatch.setenv("TABFORMER_CSV", "does-not-exist.csv")
    dataset.load_replay_cases("r", 50)
    assert dataset.stats["source"].startswith("generated fallback")
