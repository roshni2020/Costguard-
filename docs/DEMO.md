# SwitchProof demo script

Before you start: run `bash infra/preflight.sh` on `sp-control` (all PASS). Open the UI through the NetBird URL with `?theme=dark`, create one run beforehand as a backup, and keep the snapshot URL open in a second tab.

## 3-minute live script

| Time | Say | Click |
| --- | --- | --- |
| 0:00 | "In 2018 TSB's platform migration went wrong. The FCA and PRA fined them £48.65m, on top of £32.7m paid to customers. Every bank that swaps its payment switch runs that risk. SwitchProof is a team of AI agents that proves the new switch behaves like the old one before go-live." | Top bar: point at **LIVE on Vultr · <region> · 1 VM + VKE**, the **NetBird** shield, the **Vultr · laguna-s-2.1** model chip and your **NetBird SSO** identity. |
| 0:20 | "The tester writes the rules in plain English, like approve with funds, decline for insufficient funds, reject a duplicate within 60 seconds, reverse and restore. She also sets bounds for the agents." | **1 Rules** is prefilled: four rule cards, bound pills, the *Replay* toggle. Click **Generate tests with Vultr AI**. |
| 0:40 | "The coordinator runs a tool-calling loop on Vultr Serverless Inference. The planner splits the rules into states, and the generator writes ISO 8583 test cases." | Stay on **2 Approve** while the agent log fills. Optional: click **Agents** to show the hub diagram with the active spoke, then come back. |
| 1:00 | "Nothing runs until she approves. Here's the duplicate test: $250 on card ending 1111, then the same purchase at t+5 s, expect 94 Duplicate transmission." | Point at the progress ring, the lock panel and the padlock in the left stepper (*gate locked*). Click **Edit** on one case, change the amount, **Save**. Click **Approve all**: the padlock opens and the Run button glows. Click **Run approved tests in sandboxes**. |
| 1:25 | "Every batch runs as a throwaway Kubernetes Job under gVisor on Vultr Kubernetes Engine: no egress, read-only root, no credentials, deleted afterwards. Two legacy copies filter noise." | **3 Run**: packets fly from the card terminal to OLD A, OLD B and NEW. Counters climb. The gVisor pod tiles (one Job each) spawn, run and turn *destroyed ✓* in two lanes: *Agent sandboxes* and *Data sandboxes*, with a wall between them labelled *separate namespaces · separate VMs*. Wait for the red banner: **New switch approved a duplicate $250.00 payment.** NEW turns red: *Charged twice: +$250.00*. |
| 1:50 | "Both legacy copies said 94. The new switch said 00, so the customer was charged twice: minus $500 instead of minus $250. The triage agent ran follow-ups inside her bounds and found the boundary: retries one second or more apart get approved." | **4 Evidence**: the diagram replays the case (step 1: 00/00/00, step 2: 94/94/00). Then the steps table, the balance bars (−$250.00 vs −$500.00), the boundary chart, the triage report, and the GitHub issue plus the *Evidence bundle on Vultr Object Storage* link. |
| 2:25 | "She blocks the migration, and the GitHub release check turns red." | **5 Decision**: the reviewer is prefilled from NetBird SSO. Optional: **Create temporary reviewer link** (URL + PIN, dies with the decision). Click **Block migration**: the *MIGRATION BLOCKED* stamp shows *Blocked by … · authenticated by NetBird SSO · GitHub gate: failure*. Switch to the GitHub tab to show the red check. |
| 2:40 | "What if an agent writes rm -rf /? Nothing on either host dies." | **Infrastructure** tab: the `sp-control` VM card (instance id, region, plan, IPs), the **Vultr Kubernetes Engine** card (RuntimeClass gvisor ✓, runner image from Vultr Container Registry, and the agent and data pools side by side, each with its own node: "Agent code and customer-like data never share a sandbox or a machine"), storage, the hardening checklist, and the NetBird card (no inbound ports, P2P peer). **Run isolation probe**: `rm -rf /`, egress, cloud metadata and more, all BLOCKED. Active sandboxes: 0. |
| 2:55 | "Blast radius zero: humans approve, sandboxes contain, Vultr runs it all." | End. |

If there's time: **RL explorer** → **Train RL explorer on CPU**. "Trained inside a sandbox on 7 mutant switches, evaluated on a held-out bug. Honest result: it finds bugs from families it trained on about 2.7x sooner than random, but not the held-out one, because nothing in training looks like it." Read the two first-find numbers off the screen.

## 1-minute video shot list (record at 1280×720)

| Time | Shot |
| --- | --- |
| 0:00 | TSB headline card: "TSB fined £48.65m after IT migration failure (FCA, Dec 2022)". Cut to the SwitchProof top bar. |
| 0:10 | **Rules**: prefilled form, cursor on *Generate tests with Vultr AI*, click. |
| 0:20 | **Approve**: lock panel, then the padlock opens. Voice-over: "nothing runs until she approves". Click *Approve all*, then *Run*. |
| 0:30 | **Run**: packets to OLD A / OLD B / NEW, counters climbing, gVisor tiles, red banner, NEW turns red. |
| 0:45 | **Evidence**: diagram replay 94/94/00, balance bars "Customer overcharged $250.00", boundary chart, GitHub issue *pending*. |
| 0:55 | **Decision**: click *Block migration*. MIGRATION BLOCKED stamp, GitHub gate *failure*. |

## Fallback

- **Backend or NetBird down**: open `https://<owner>.github.io/<repo>/?snapshot=export.json` (published with `infra/publish_snapshot.sh <run_id>`). The banner reads *Recorded run from our Vultr deployment — live app is behind NetBird*. Every step and tab works read-only.
- **No snapshot either**: open `web/index.html?mock=1` from any static server (`python -m http.server -d web 8080`). It is a fixture-driven replay of all 5 steps, with a banner saying so.
- **LLM slow**: the pre-created backup run in the top-bar run switcher is already at *Awaiting decision*.

## Judge questions

**"Show me the instance."** Open the Vultr console → Compute: `sp-control` (VX1, on `sp-vpc`), then Kubernetes: the `sp-sandboxes` cluster and its node pool. In the app, the **Infrastructure** tab shows each VM's Vultr instance id, region, plan and IPs, read from the instance metadata. On `sp-control`: `systemctl status switchproof-control`. During a run, `kubectl get jobs -n switchproof-sandbox -w` shows one Job per batch appearing and being deleted, each with `runtimeClassName: gvisor`.

**"Is the model Vultr's?"** Yes. `LLM_BASE_URL=https://api.vultrinference.com/v1` is set in `/etc/switchproof.env` on `sp-control`. Every LLM call in the Agents tab shows *Vultr · <model>* with tokens and latency, and expands to the exact prompt and reply. The Vultr console → Serverless Inference usage shows the same calls.

**"If I paste rm -rf /, what dies?"** Only a throwaway sandbox that was going to be deleted anyway. Agent-written code runs only inside a gVisor pod (a Kubernetes Job on VKE), with a read-only root, egress denied by NetworkPolicy, no ServiceAccount token, all capabilities dropped, and no host mounts. The Job is deleted after the batch. Agent-written code only ever runs in the agent pool (namespace `switchproof-agent`, its own VM), so even that one pod never shares a machine with the replay data, which runs in the data pool on a different VM. Infrastructure → **Run isolation probe** runs it live, and `rm -rf /` comes back BLOCKED, as does the cloud metadata service (the VM can read its Vultr metadata; the sandbox cannot). The control plane never executes generated code. It treats LLM output as data validated against a schema.

**"How do I get in if no port is open?"** Through the NetBird reverse proxy URL. The Vultr VM has no inbound app port, and the cluster is reached only by the control plane through the Kubernetes API. NetBird SSO decides your role: the `testers` group can act, and everyone else is read-only. A temporary reviewer link with a PIN dies automatically when the decision is recorded.

**"How do you know it's a real regression and not flakiness?"** There are two identical legacy switches. If `old_a` and `old_b` disagree, the verdict is *noise*. A regression means both legacy copies match the expected result and the new switch doesn't.

**"Is this real bank data?"** No. It's IBM TabFormer, a public synthetic benchmark, and the defect is seeded. We say so on screen.

**"What does the human actually control?"** Every test (approve, reject or edit), the replay pack (off until switched on), the bounds that triage follow-ups must stay inside, and the release decision. The server refuses to execute (409) while any test is unapproved.

## Recording tips

- Browser window 1280×720, zoom 100–110%, `?theme=dark` (the mission-control look), hide bookmarks bar.
- Pre-warm: run one full story before recording so the LLM and sandbox image are hot.
- Keep the GitHub PR / commit page open in a second tab for the red check.
- Record the voice-over separately and keep the cursor slow. Pause for 1 s on the red banner and the Block click.
