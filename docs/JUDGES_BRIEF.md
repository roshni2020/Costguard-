# SwitchProof: judge brief

## The 30-second pitch

Banks replace their payment systems every decade or so, and when it goes wrong customers pay: TSB's 2018 migration cost about **£81m** in fines and compensation. **SwitchProof is an AI test team for payment migrations.** A tester writes the rules in plain English. AI agents on **Vultr Serverless Inference** write the tests. **Nothing runs until a human approves every test.** The tests run in **throwaway gVisor sandboxes on Vultr Kubernetes**, comparing the old payment system with the new one. When the new one gets money wrong, an agent investigates on its own and explains why, and **the human blocks or approves the launch.**

## What happens in a run

1. **Rules:** the tester types requirements, e.g. *"Reject a duplicate purchase within 60 seconds."*
2. **Approve:** the agents propose about 14 concrete tests. The server refuses to run anything until each one is approved or rejected.
3. **Run:** approved tests plus 2,000 to 10,000 replayed transactions go to Vultr Kubernetes. Every batch gets a fresh gVisor sandbox, which is deleted when it finishes.
4. **Evidence:** triage spots a regression, designs its own follow-up tests, finds the exact boundary, and estimates the money at risk.
5. **Decide:** the tester clicks **Block migration** or **Approve release**. Their name is recorded, and the GitHub release gate follows.

**What we catch in the demo:** a customer's $250 purchase is retried 5 seconds later. The old system says *"duplicate, rejected"* and charges once. The new system approves it again and **charges $500**. Triage found on its own that retries **1 second or more apart** slip through, and diagnosed the cause: *the 60-second window is read as milliseconds.* (We planted this bug on purpose so the demo is repeatable.)

## Why it's really agentic

- **Eight agents, one coordinator loop.** Each loop the coordinator looks at the run, asks the model what to do next, hands the job to one agent, and logs everything.
- **The agents:**
  - **GLM-5.3** handles the reasoning: coordinator, planner, triage, and an analyst that answers questions about a run.
  - **DeepSeek-v4.1-flash** writes the tests.
  - The executor and the RL explorer are plain compute, with no model.
- **Autonomy inside limits:** triage designs and runs follow-up tests **without asking**, but only within the amounts and message types the human approved.
- **Guardrails live in code, not in the prompt:**
  - A run can't start while any test is unapproved.
  - At most 12 loop steps happen between human gates.
  - An invalid AI choice is rejected.

## Blast radius zero

- **Two sandbox pools on separate Vultr VMs.** AI-written tests run in the *agent* pool. The replay data runs in the *data* pool, which never runs agent code. Even an escape wouldn't reach the data.
- **Each sandbox:**
  - runs under the gVisor kernel (`4.19.0-gvisor`);
  - has no network, a read-only disk and no credentials, with all Linux capabilities dropped;
  - is capped by a quota;
  - is **deleted after every batch**.
- **We attacked it for real.** Inside a live sandbox on our cluster we tried `rm -rf /`, reaching the internet, DNS, the control plane, the cloud metadata service, writing system files and a Docker-socket escape. **All 7 were blocked.**

## How we used Vultr (everything in Atlanta)

| Vultr product | Its job in SwitchProof |
|---|---|
| **Compute (VX1 VM, `sp-control`)** | Web app, agent loop, database |
| **Kubernetes Engine** | Two node pools; every test batch is a gVisor Job, deleted after |
| **Serverless Inference** | Every agent decision (GLM-5.3, DeepSeek-v4.1-flash) |
| **Container Registry** | The sandbox image the cluster pulls |
| **Object Storage** | Evidence bundle for each run, plus the public demo page |
| **Block Storage (40 GB)** | Database and the 2.2 GB IBM TabFormer dataset |
| **VPC + Firewall** | Private network; the app port is closed, SSH by key only |

Why Atlanta: it's the only region serving our models, so everything sits next to the AI.

## Real numbers (one run on our Vultr deployment)

**10,022 tests** · **42 gVisor sandboxes**, all destroyed · **0 errors** · defect found **8.9 s** after pressing Run · **175** double-charge regressions · **$9,053** of customer money at risk · **100%** of AI-written tests expected the right answer · **$0.04** total AI cost (13 calls, 37,803 tokens) · 162 s end to end.

---

## Questions judges will ask

**"Is this real or mocked?"**
The **payment switches are simulated**, because no bank lets a hackathon team test on its core system. Everything else is live: the AI calls, the Kubernetes sandboxes, the storage and the VM. Open **/proof.html** to show the real Vultr instance ID, pod names appearing and being destroyed, and the actual model reply.

**"Is the model yours / is it Vultr's?"**
Vultr Serverless Inference. The Agents page lists every call with the model name, tokens and response time, and "Show raw LLM calls" reveals the exact prompt and reply.

**"If I paste `rm -rf /`, what dies?"**
Only a throwaway sandbox that was about to be deleted anyway. We ran exactly that on the cluster and it was blocked. The sandbox has a read-only disk, no network, and runs on a VM separate from the data.

**"Is it using live data?"**
No live customer data, on purpose. It replays **IBM TabFormer**, a real published dataset of synthetic card transactions; the app shows "500,000 rows scanned". A bank would replay its own anonymized history against its **test copies** of the old and new systems. That's a standard "parallel run" before go-live, never production money.

**"How would an enterprise use this?"**
As the release gate for a payment migration. Every release candidate goes through SwitchProof, and nothing ships until the report is clean or a named person accepts the risk. To connect a real bank, we'd point the sandboxes at its test endpoints and allow only those addresses through the network rule.

**"What about prompt injection?"**
The AI can at most *propose* a bad test, and a human sees it before anything runs. The limits are enforced in code, and the replay data never goes to the AI.

**"Did you use NetBird?"**
The integration is built (zero-port access, SSO roles, expiring reviewer links) but **not enabled** on this deployment. We say so in the README.

**"What didn't work?"**
The RL explorer learns to find bug types it trained on faster than random (4.7 vs 12.6 tries), but **not** the held-out bug (21.8 vs 5.8). We report that as it is.

## Links

- Code: https://github.com/roshni2020/Costguard-
- Public demo (recorded Vultr run): https://atl2.vultrobjects.com/switchproof-roshni/site/index.html?snapshot=export.json
- Live proof page (when the app is open): `/proof.html`
