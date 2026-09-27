"""python -m rl.experiment  (args JSON on stdin: {"train_episodes": 400, "eval_seeds": 30, "budget": 60})
Train on TRAINING_BUGS only, evaluate learned policy vs random ordering on the HELD-OUT bug. Prints one JSON line."""
from __future__ import annotations
import json
import os
import random
import sys
import tempfile
import time

from rl.agent import Agent
from rl.env import ARMS, Episode
from switchcore.bugs import HOLDOUT_BUG, TRAINING_BUGS


def run_policy(pick, bugs: set[str], budget: int) -> tuple[list[int], int]:
    """Cumulative regressions found after each execution, and executions to first find (budget+1 if never)."""
    ep = Episode(bugs, budget)
    curve, first = [], budget + 1
    for t in range(budget):
        _, new = ep.step(pick(ep))
        if new and first > budget:
            first = t + 1
        curve.append(len(ep.found))
    return curve, first


def evaluate(agent: Agent, bug_sets: list[set[str]], budget: int, seed: int) -> dict:
    rng = random.Random(seed)
    out = {}
    for name in ("learned", "random"):
        curves, firsts = [], []
        for i, bugs in enumerate(bug_sets):
            if name == "learned":
                agent.rng = random.Random(seed * 1000 + i)
                pick = lambda ep: agent.choose(ep, 0.05)
            else:  # random test ordering without repeats (a stronger baseline than sampling with replacement)
                order = rng.sample(range(len(ARMS)), len(ARMS))
                pick = lambda ep, order=order: order[len(ep.tried)] if len(ep.tried) < len(order) else rng.randrange(len(ARMS))
            c, f = run_policy(pick, bugs, budget)
            curves.append(c)
            firsts.append(f)
        out[name] = ([round(sum(col) / len(col), 3) for col in zip(*curves)], round(sum(firsts) / len(firsts), 2))
    return out


def main(args: dict) -> dict:
    episodes, seeds, budget = args.get("train_episodes", 400), args.get("eval_seeds", 30), args.get("budget", 60)
    rng = random.Random(args.get("seed", 42))
    t0 = time.perf_counter()
    train_sets = [set(rng.sample(TRAINING_BUGS, rng.choice([1, 2]))) for _ in range(episodes)]
    agent = Agent(seed=1)
    agent.train(train_sets, budget)
    train_s = time.perf_counter() - t0
    path = args.get("save_path") or os.path.join(tempfile.gettempdir(), "switchproof_rl_weights.json")
    agent.save(path)

    holdout = evaluate(agent, [{HOLDOUT_BUG}] * seeds, budget, seed=7)
    mix = evaluate(agent, [set(rng.sample(TRAINING_BUGS, 1)) for _ in range(seeds)], budget, seed=8)
    top = sorted(range(len(ARMS)), key=lambda a: -agent.q(a, Episode(set())))[:8]
    return {
        "episodes": episodes, "trained_on_bugs": TRAINING_BUGS, "holdout_bug": HOLDOUT_BUG, "seeds": seeds, "budget": budget,
        "n_arms": len(ARMS), "train_seconds": round(train_s, 2), "total_seconds": round(time.perf_counter() - t0, 2),
        "curves": {"learned": holdout["learned"][0], "random": holdout["random"][0],
                   "learned_training_mix": mix["learned"][0], "random_training_mix": mix["random"][0]},
        "first_find": {"learned": holdout["learned"][1], "random": holdout["random"][1],
                       "learned_training_mix": mix["learned"][1], "random_training_mix": mix["random"][1]},
        "top_arms_before_any_result": [" ".join(str(x) for x in ARMS[a] if x is not None) for a in top],
        "baseline": "random ordering of the same arms without repeats",
        "weights_path": path,
    }


if __name__ == "__main__":
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    out = main(json.loads(raw) if raw.strip() else {})
    from switchcore.runner import proof
    out["_proof"] = proof().model_dump()       # sandbox host strips this into JobResult.proof
    print(json.dumps(out))
