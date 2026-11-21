"""Git status, diff, safe file revert, and isolated .0g-worktrees manager."""

from __future__ import annotations

import ctypes
import os
import re
import shutil
import subprocess
from typing import Any

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000

_SAFE_BRANCH_RE = re.compile(r"[^A-Za-z0-9._/-]+")


def _win32_full_path(path: str) -> str:
    """Resolve full path via Win32 GetFullPathNameW + os.path.realpath."""
    real = os.path.realpath(path)
    if not IS_WINDOWS:
        return real
    try:
        kernel32 = ctypes.windll.kernel32
        needed = kernel32.GetFullPathNameW(real, 0, None, None)
        if needed <= 0:
            return real
        buf = ctypes.create_unicode_buffer(needed + 1)
        written = kernel32.GetFullPathNameW(real, needed + 1, buf, None)
        if written > 0:
            return os.path.realpath(buf.value)
    except Exception:
        pass
    return real


def _resolve_inside_repo(repo_path: str, file_path: str, allow_dot_git: bool = False) -> tuple[bool, str, str]:
    """Validate that file_path resolves strictly inside repo_path without traversal."""
    if not repo_path or not file_path:
        return False, "", "Empty repo_path or file_path"
    normalized_file_path = file_path.replace("\\", "/")
    repo_abs = _win32_full_path(repo_path)
    candidate = normalized_file_path if os.path.isabs(normalized_file_path) else os.path.join(repo_abs, normalized_file_path)
    target_abs = _win32_full_path(candidate)

    repo_cmp = os.path.normcase(repo_abs)
    target_cmp = os.path.normcase(target_abs)

    try:
        common = os.path.commonpath([repo_cmp, target_cmp])
    except ValueError:
        return False, "", "Target path is on a different drive or outside repository"

    if common != repo_cmp or target_cmp == repo_cmp:
        return False, "", "Target path escapes repository root"

    rel = os.path.relpath(target_abs, repo_abs).replace("\\", "/")
    if not allow_dot_git and (rel == ".git" or rel.startswith(".git/")):
        return False, "", "Refusing to modify .git metadata"

    return True, rel, ""


class GitManager:
    """Safe Git operations with GIT_OPTIONAL_LOCKS=0 for background polling and worktree isolation."""

    def __init__(self, timeout_sec: float = 12.0) -> None:
        self.timeout_sec = max(2.0, float(timeout_sec))

    def _run_git(
        self,
        repo_path: str,
        args: list[str],
        read_only: bool = True,
        timeout_sec: float | None = None,
    ) -> tuple[int, str, str]:
        git_exe = shutil.which("git") or "git"
        env = os.environ.copy()
        if read_only:
            env["GIT_OPTIONAL_LOCKS"] = "0"
        env.setdefault("GIT_TERMINAL_PROMPT", "0")
        effective_timeout = float(timeout_sec) if timeout_sec is not None else self.timeout_sec

        try:
            proc = subprocess.run(
                [git_exe, *args],
                cwd=repo_path,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=effective_timeout,
                creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
            )
            return proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired:
            return 124, "", f"git {' '.join(args)} timed out"
        except FileNotFoundError:
            return 127, "", "git executable not found on PATH"
        except Exception as exc:
            return 1, "", str(exc)

    def _is_git_repo(self, repo_path: str) -> bool:
        if not repo_path or not os.path.isdir(repo_path):
            return False
        rc, out, _ = self._run_git(repo_path, ["rev-parse", "--is-inside-work-tree"], read_only=True)
        return rc == 0 and out.strip().lower() == "true"

    def get_head_sha(self, repo_path: str) -> str | None:
        if not repo_path or not os.path.isdir(repo_path):
            return None
        rc, out, _ = self._run_git(repo_path, ["rev-parse", "HEAD"], read_only=True)
        if rc != 0:
            return None
        sha = out.strip()
        return sha or None

    def get_branch(self, repo_path: str) -> str | None:
        if not repo_path or not os.path.isdir(repo_path):
            return None
        rc, out, _ = self._run_git(repo_path, ["rev-parse", "--abbrev-ref", "HEAD"], read_only=True)
        if rc != 0:
            return None
        branch = out.strip()
        return branch or None

    def get_status(self, repo_path: str) -> dict[str, Any]:
        if not self._is_git_repo(repo_path):
            return {
                "ok": False,
                "isRepo": False,
                "repoPath": repo_path,
                "branch": None,
                "headSha": None,
                "clean": True,
                "files": [],
                "worktrees": [],
                "error": "Not a git repository",
            }

        branch = self.get_branch(repo_path)
        head_sha = self.get_head_sha(repo_path)
        rc, out, err = self._run_git(
            repo_path,
            ["status", "--porcelain=v1", "-uall"],
            read_only=True,
        )
        if rc != 0:
            return {
                "ok": False,
                "isRepo": True,
                "repoPath": repo_path,
                "branch": branch,
                "headSha": head_sha,
                "clean": False,
                "files": [],
                "worktrees": [],
                "error": err.strip() or "git status failed",
            }

        files: list[dict[str, str]] = []
        for raw_line in out.splitlines():
            if len(raw_line) < 4:
                continue
            xy = raw_line[:2]
            path = raw_line[3:].strip()
            if " -> " in path:
                path = path.split(" -> ", 1)[1].strip()
            if path.startswith('"') and path.endswith('"'):
                path = path[1:-1]
            status_label = "untracked" if xy == "??" else ("modified" if "M" in xy else ("added" if "A" in xy else ("deleted" if "D" in xy else xy.strip())))
            files.append(
                {
                    "path": path,
                    "indexStatus": xy[0],
                    "worktreeStatus": xy[1],
                    "status": status_label,
                }
            )

        worktrees = self._list_worktrees(repo_path)
        return {
            "ok": True,
            "isRepo": True,
            "repoPath": _win32_full_path(repo_path),
            "branch": branch,
            "headSha": head_sha,
            "clean": len(files) == 0,
            "files": files,
            "worktrees": worktrees,
            "error": None,
        }

    def _list_worktrees(self, repo_path: str) -> list[dict[str, str]]:
        rc, out, _ = self._run_git(repo_path, ["worktree", "list", "--porcelain"], read_only=True)
        if rc != 0:
            return []
        entries: list[dict[str, str]] = []
        current: dict[str, str] = {}
        for line in out.splitlines():
            if not line.strip():
                if current:
                    entries.append(current)
                    current = {}
                continue
            if line.startswith("worktree "):
                current["path"] = line[9:].strip()
            elif line.startswith("HEAD "):
                current["head"] = line[5:].strip()
            elif line.startswith("branch "):
                current["branch"] = line[7:].strip().removeprefix("refs/heads/")
            elif line.strip() == "detached":
                current["branch"] = "detached"
        if current:
            entries.append(current)
        return entries

    def get_diff(self, repo_path: str, file_path: str | None = None) -> dict[str, Any]:
        if not self._is_git_repo(repo_path):
            return {"ok": False, "diff": "", "stagedDiff": "", "error": "Not a git repository"}

        path_args: list[str] = []
        rel_path: str | None = None
        if file_path:
            ok, rel, err_msg = _resolve_inside_repo(repo_path, file_path, allow_dot_git=False)
            if not ok:
                return {"ok": False, "diff": "", "stagedDiff": "", "error": err_msg}
            rel_path = rel
            path_args = ["--", rel]

        rc_unstaged, unstaged, err_unstaged = self._run_git(
            repo_path,
            ["diff", "--no-color", *path_args],
            read_only=True,
        )
        rc_staged, staged, err_staged = self._run_git(
            repo_path,
            ["diff", "--cached", "--no-color", *path_args],
            read_only=True,
        )

        if rc_unstaged != 0 and rc_staged != 0:
            return {
                "ok": False,
                "filePath": rel_path,
                "diff": "",
                "stagedDiff": "",
                "error": (err_unstaged or err_staged).strip() or "git diff failed",
            }

        combined = unstaged
        if staged.strip():
            combined = f"{unstaged}\n# --- STAGED ---\n{staged}".strip()

        return {
            "ok": True,
            "filePath": rel_path,
            "diff": combined,
            "unstagedDiff": unstaged,
            "stagedDiff": staged,
            "error": None,
        }

    def revert_file(self, repo_path: str, file_path: str) -> dict[str, Any]:
        if not self._is_git_repo(repo_path):
            return {"ok": False, "filePath": file_path, "error": "Not a git repository"}

        ok, rel, err_msg = _resolve_inside_repo(repo_path, file_path, allow_dot_git=False)
        if not ok:
            return {"ok": False, "filePath": file_path, "error": err_msg}

        # Check if file is tracked in HEAD or index
        rc_ls, ls_out, _ = self._run_git(repo_path, ["ls-files", "--", rel], read_only=True)
        is_tracked = rc_ls == 0 and bool(ls_out.strip())

        if is_tracked:
            rc, _, err = self._run_git(
                repo_path,
                ["restore", "--staged", "--worktree", "--source=HEAD", "--", rel],
                read_only=False,
            )
            if rc != 0:
                rc, _, err = self._run_git(repo_path, ["checkout", "--", rel], read_only=False)
            if rc != 0:
                return {"ok": False, "filePath": rel, "error": err.strip() or "git restore failed"}
            return {"ok": True, "filePath": rel, "action": "restored", "error": None}

        # Untracked file inside repo: remove via git clean -fd
        rc, _, err = self._run_git(repo_path, ["clean", "-fd", "--", rel], read_only=False)
        if rc != 0:
            return {"ok": False, "filePath": rel, "error": err.strip() or "git clean failed"}
        return {"ok": True, "filePath": rel, "action": "removed_untracked", "error": None}

    def create_worktree(self, repo_path: str, branch_name: str) -> dict[str, Any]:
        if not self._is_git_repo(repo_path):
            return {"ok": False, "worktreePath": "", "branchName": branch_name, "headSha": None, "error": "Not a git repository"}

        repo_abs = _win32_full_path(repo_path)
        sanitized_branch = _SAFE_BRANCH_RE.sub("-", branch_name.strip()).strip("-./")
        if not sanitized_branch:
            return {"ok": False, "worktreePath": "", "branchName": branch_name, "headSha": None, "error": "Invalid branch name"}

        folder_name = sanitized_branch.replace("/", "__")
        worktrees_root = os.path.join(repo_abs, ".0g-worktrees")
        os.makedirs(worktrees_root, exist_ok=True)
        worktree_path = os.path.join(worktrees_root, folder_name)

        # Check if branch already exists
        rc_ref, _, _ = self._run_git(repo_abs, ["show-ref", "--verify", "--quiet", f"refs/heads/{sanitized_branch}"], read_only=True)
        if rc_ref == 0:
            rc, _, err = self._run_git(repo_abs, ["worktree", "add", worktree_path, sanitized_branch], read_only=False)
        else:
            rc, _, err = self._run_git(repo_abs, ["worktree", "add", "-b", sanitized_branch, worktree_path], read_only=False)

        if rc != 0:
            return {
                "ok": False,
                "worktreePath": worktree_path,
                "branchName": sanitized_branch,
                "headSha": None,
                "error": err.strip() or "git worktree add failed",
            }

        return {
            "ok": True,
            "worktreePath": _win32_full_path(worktree_path),
            "branchName": sanitized_branch,
            "headSha": self.get_head_sha(worktree_path),
            "error": None,
        }

    def merge_worktree(self, repo_path: str, worktree_path: str, branch_name: str) -> dict[str, Any]:
        if not self._is_git_repo(repo_path):
            return {"ok": False, "merged": False, "error": "Not a git repository"}

        repo_abs = _win32_full_path(repo_path)
        sanitized_branch = _SAFE_BRANCH_RE.sub("-", branch_name.strip()).strip("-./")

        # Validate worktree_path inside repo
        ok_wt, _, wt_err = _resolve_inside_repo(repo_abs, worktree_path, allow_dot_git=False)
        if not ok_wt:
            return {"ok": False, "merged": False, "error": f"Invalid worktree path: {wt_err}"}

        rc_merge, merge_out, merge_err = self._run_git(
            repo_abs,
            ["merge", "--no-edit", sanitized_branch],
            read_only=False,
        )
        if rc_merge != 0:
            # Abort conflicted merge so main working tree stays clean
            self._run_git(repo_abs, ["merge", "--abort"], read_only=False)
            return {
                "ok": False,
                "merged": False,
                "branchName": sanitized_branch,
                "error": (merge_err or merge_out).strip() or "Merge conflict; aborted cleanly",
            }

        # Clean up worktree and branch after clean merge
        self._run_git(repo_abs, ["worktree", "remove", worktree_path], read_only=False)
        self._run_git(repo_abs, ["worktree", "prune"], read_only=False)
        self._run_git(repo_abs, ["branch", "-d", sanitized_branch], read_only=False)

        return {
            "ok": True,
            "merged": True,
            "branchName": sanitized_branch,
            "headSha": self.get_head_sha(repo_abs),
            "message": merge_out.strip() or "Merged and cleaned up worktree",
            "error": None,
        }

    def discard_worktree(self, repo_path: str, worktree_path: str, branch_name: str) -> dict[str, Any]:
        if not self._is_git_repo(repo_path):
            return {"ok": False, "discarded": False, "error": "Not a git repository"}

        repo_abs = _win32_full_path(repo_path)
        sanitized_branch = _SAFE_BRANCH_RE.sub("-", branch_name.strip()).strip("-./")

        ok_wt, _, wt_err = _resolve_inside_repo(repo_abs, worktree_path, allow_dot_git=False)
        if not ok_wt:
            return {"ok": False, "discarded": False, "error": f"Invalid worktree path: {wt_err}"}

        rc_rm, _, err_rm = self._run_git(
            repo_abs,
            ["worktree", "remove", "--force", worktree_path],
            read_only=False,
        )
        self._run_git(repo_abs, ["worktree", "prune"], read_only=False)
        if sanitized_branch:
            self._run_git(repo_abs, ["branch", "-D", sanitized_branch], read_only=False)

        if rc_rm != 0 and os.path.exists(worktree_path):
            return {
                "ok": False,
                "discarded": False,
                "branchName": sanitized_branch,
                "error": err_rm.strip() or "Failed to remove worktree",
            }

        return {
            "ok": True,
            "discarded": True,
            "branchName": sanitized_branch,
            "error": None,
        }

    def commit_and_push(
        self,
        repo_path: str,
        message: str,
        push: bool = True,
    ) -> dict[str, Any]:
        if not self._is_git_repo(repo_path):
            return {
                "ok": False,
                "committed": False,
                "pushed": False,
                "error": "Not a git repository",
            }

        clean_msg = (message or "").strip()
        if not clean_msg:
            return {
                "ok": False,
                "committed": False,
                "pushed": False,
                "error": "Commit message is required",
            }

        rc_add, _, err_add = self._run_git(repo_path, ["add", "-A"], read_only=False)
        if rc_add != 0:
            return {
                "ok": False,
                "committed": False,
                "pushed": False,
                "error": err_add.strip() or "git add failed",
            }

        rc_st, st_out, st_err = self._run_git(
            repo_path,
            ["status", "--porcelain=v1"],
            read_only=True,
        )
        if rc_st != 0:
            return {
                "ok": False,
                "committed": False,
                "pushed": False,
                "error": st_err.strip() or "git status failed",
            }
        if not st_out.strip():
            return {
                "ok": False,
                "committed": False,
                "pushed": False,
                "error": "Nothing to commit (working tree clean)",
            }

        rc_cm, cm_out, cm_err = self._run_git(
            repo_path,
            ["commit", "-m", clean_msg],
            read_only=False,
        )
        if rc_cm != 0:
            combined_cm = f"{cm_out}\n{cm_err}"
            if (
                "Please tell me who you are" in combined_cm
                or "Author identity unknown" in combined_cm
            ):
                rc_cm, cm_out, cm_err = self._run_git(
                    repo_path,
                    [
                        "-c",
                        "user.name=Antigravity Remote",
                        "-c",
                        "user.email=remote@antigravity.local",
                        "commit",
                        "-m",
                        clean_msg,
                    ],
                    read_only=False,
                )
        if rc_cm != 0:
            return {
                "ok": False,
                "committed": False,
                "pushed": False,
                "error": cm_err.strip() or cm_out.strip() or "git commit failed",
            }

        commit_sha = self.get_head_sha(repo_path)
        branch = self.get_branch(repo_path)

        if not push:
            return {
                "ok": True,
                "committed": True,
                "pushed": False,
                "commitSha": commit_sha,
                "branch": branch,
                "pushOutput": "",
                "error": None,
            }

        push_rc, push_out, push_err = self._run_git(
            repo_path,
            ["push"],
            read_only=False,
            timeout_sec=max(self.timeout_sec, 25.0),
        )
        return {
            "ok": push_rc == 0,
            "committed": True,
            "pushed": push_rc == 0,
            "commitSha": commit_sha,
            "branch": branch,
            "pushOutput": (push_out + "\n" + push_err).strip(),
            "error": None if push_rc == 0 else (push_err.strip() or "git push failed"),
        }

