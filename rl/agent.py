"""Linear value learner over arm features (a contextual bandit). Features shared across a bug FAMILY are what let
experience with training bugs transfer to the held-out one; tabular per-arm values could not generalise."""
from __future__ import annotations
import json
import random

from rl.env import ARMS, FAMILY, Episode


def features(arm_idx: int, ep: Episode) -> dict[str, float]:
    op, gap, bucket = ARMS[arm_idx]
    fam = FAMILY[op]
    f = {"bias": 1.0, f"fam:{fam}": 1.0, f"op:{op}": 1.0, f"amt:{bucket}": 1.0,
         f"fam_miss:{fam}": min(ep.misses.get(fam, 0), 4) / 4}
    if gap is not None:
        f[f"gap:{gap}"] = 1.0
    return f


class Agent:
    def __init__(self, lr: float = 0.05, seed: int = 0):
        self.w: dict[str, float] = {}
        self.lr = lr
        self.rng = random.Random(seed)

    def q(self, arm_idx: int, ep: Episode) -> float:
        return sum(self.w.get(k, 0.0) * v for k, v in features(arm_idx, ep).items())

    def choose(self, ep: Episode, eps: float) -> int:
        fresh = [a for a in range(len(ARMS)) if a not in ep.tried] or list(range(len(ARMS)))
        if self.rng.random() < eps:
            return self.rng.choice(fresh)
        return max(fresh, key=lambda a: (self.q(a, ep), self.rng.random()))

    def update(self, arm_idx: int, ep: Episode, reward: float, feats: dict[str, float]) -> None:
        err = reward - sum(self.w.get(k, 0.0) * v for k, v in feats.items())
        for k, v in feats.items():
            self.w[k] = self.w.get(k, 0.0) + self.lr * err * v

    def train(self, bug_sets: list[set[str]], budget: int, eps_start: float = 0.3, eps_end: float = 0.05) -> None:
        n = len(bug_sets)
        for i, bugs in enumerate(bug_sets):
            eps = eps_start + (eps_end - eps_start) * i / max(n - 1, 1)
            ep = Episode(bugs, budget)
            for _ in range(budget):
                a = self.choose(ep, eps)
                feats = features(a, ep)          # context before the step
                r, _ = ep.step(a)
                self.update(a, ep, r, feats)

    def save(self, path: str) -> None:
        with open(path, "w") as fh:
            json.dump(self.w, fh, indent=1, sort_keys=True)
