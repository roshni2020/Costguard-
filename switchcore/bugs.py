BUG_LIBRARY: dict[str, str] = {
    "dup_window_units": "Duplicate window 60 is read as milliseconds, so a duplicate arriving 1+ seconds later is approved (00) and debited twice.",
    "reversal_no_credit": "Reversal returns 00 but does not credit the balance.",
    "reversal_double_credit": "A second reversal of the same STAN returns 00 and credits again.",
    "nsf_exact_balance": "Uses balance <= amount, so a purchase of exactly the balance is declined 51.",
    "expiry_month_off_by_one": "A card expiring this month is declined 54.",
    "glitch_fail_open": "Technical glitch returns 00 instead of 96 and debits.",
    "pin_ignored_swipe": "pin_ok=false still approves when entry_mode is swipe.",
    "dup_key_ignores_amount": "Different amounts with the same PAN+STAN inside the window are rejected 94.",
}

HOLDOUT_BUG = "dup_window_units"                      # demo bug, never used for RL training
TRAINING_BUGS = [b for b in BUG_LIBRARY if b != HOLDOUT_BUG]
