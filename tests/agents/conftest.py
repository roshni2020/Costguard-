import os
import tempfile

# must run before control_plane is imported: offline agents, fake sandbox, throwaway DB
os.environ["LLM_OFFLINE"] = "1"
os.environ.pop("SANDBOX_HOST_URL", None)
os.environ.pop("GITHUB_TOKEN", None)
os.environ["SWITCHPROOF_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")
