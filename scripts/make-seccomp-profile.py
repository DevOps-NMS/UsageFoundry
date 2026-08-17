#!/usr/bin/env python3
"""Derive uf-seccomp.json from Docker's own default seccomp profile.

The commented `security_opt` line in docker-compose.yml needs a profile that
lets bubblewrap create a user namespace. Docker's default profile does not: the
whole namespace-and-mount family is allowed only for a container that holds
CAP_SYS_ADMIN, and this one deliberately holds none, so `unshare` fails with
EPERM before the kernel is ever asked (measured in the shipped container —
`proposals/Sandboxing/10-validation.md`: plain `unshare -U`, which needs no
capability at all, fails the same way, `Seccomp: 2` with one filter loaded, and
the kernel's own `max_user_namespaces` is 31734).

So the profile ships *derived* rather than hand-written, and derived from the
engine's own default rather than from a copy of it kept here. A hand-maintained
allow-list ages in the one direction nobody notices: a base image whose libc
starts calling a syscall the snapshot never listed gets EPERM inside a tool
call, which is not a sentence anybody traces back to a security profile they
edited a year earlier. Regenerating against the tag matching your engine keeps
the other 30 rules exactly as Docker wrote them.

    python3 scripts/make-seccomp-profile.py                 # the pinned tag
    python3 scripts/make-seccomp-profile.py v28.5.2         # any moby tag

Nothing runs this automatically, and the file it writes is not in the image:
the profile is read by the Docker *daemon* on the host, not by anything inside
the container.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUTPUT = REPO / "uf-seccomp.json"

# The Docker Engine release this was last generated against. Not "latest" on
# purpose: a generator whose output moves when nobody ran it is a security
# profile nobody can review a diff of.
DEFAULT_TAG = "v28.5.2"

# Where the engine keeps the profile it applies when nothing says otherwise.
# It moved into a vendored module in the 28.x line; earlier tags have it at
# `profiles/seccomp/default.json`, which this will report rather than guess at.
SOURCE = (
    "https://raw.githubusercontent.com/moby/moby/{tag}"
    "/vendor/github.com/moby/profiles/seccomp/default.json"
)

# What bubblewrap needs and Docker's default withholds, and nothing beyond it.
#
# `unshare` and `clone` are the user namespace itself; `mount`, `umount2` and
# `pivot_root` are the mount namespace bubblewrap builds inside it, which is
# where the read-only binds and the tmpfs denies actually live. `clone3` is here
# because glibc reaches for it first and Docker's default answers ENOSYS to make
# it fall back — with `clone` allowed for these flags there is no reason to keep
# forcing the older path.
#
# Deliberately *not* here: the rest of the rule this widens
# (`bpf`, `perf_event_open`, `setns`, `syslog`, `quotactl`, `fanotify_init`,
# `sethostname`, `lookup_dcookie`, the `lsm_*` trio and the new mount API's
# `open_tree`/`move_mount`/`fs*`). They travel with `mount` in Docker's own
# CAP_SYS_ADMIN rule and none of them is a namespace, so lifting the gate
# wholesale would have widened the container by two dozen syscalls to reach six.
NAMESPACE_SYSCALLS = ["clone", "clone3", "unshare", "mount", "umount2", "pivot_root"]


def is_capability_gated_clone_rule(rule: dict) -> bool:
    """A rule that exists only to constrain clone/clone3 without CAP_SYS_ADMIN.

    Docker writes three: `clone` allowed when arg 0 carries none of the
    CLONE_NEW* bits, the same for s390's swapped argument order, and `clone3`
    answered with ENOSYS. All three are superseded by the allow rule below, and
    leaving a narrower rule beside a wider one for the same syscall would make
    the resulting filter depend on how libseccomp merges them — which is not
    something this file should be deciding by accident.
    """
    names = set(rule.get("names", []))
    if not names <= {"clone", "clone3"}:
        return False
    return "CAP_SYS_ADMIN" in rule.get("excludes", {}).get("caps", [])


def patch(profile: dict) -> dict:
    """Docker's profile with the user-namespace path opened, and nothing else."""
    syscalls = profile.get("syscalls")
    if not isinstance(syscalls, list) or not syscalls:
        raise SystemExit("the fetched profile has no `syscalls` list — check the tag")

    gated = [rule for rule in syscalls if is_capability_gated_clone_rule(rule)]
    if len(gated) != 3:
        # Loud rather than best-effort: a profile whose clone rules have been
        # reshaped upstream may need a different patch, and quietly emitting an
        # unpatched one would hand the operator a `security_opt` line that
        # changes nothing while reading as though it had.
        raise SystemExit(
            f"expected 3 capability-gated clone rules in Docker's default profile, "
            f"found {len(gated)}. The upstream profile has changed shape; re-read it "
            f"before trusting this patch."
        )

    kept = [rule for rule in syscalls if not is_capability_gated_clone_rule(rule)]
    kept.append(
        {
            "names": NAMESPACE_SYSCALLS,
            "action": "SCMP_ACT_ALLOW",
            "comment": (
                "UsageFoundry: permits bubblewrap to build a user and mount "
                "namespace. The kernel still applies its own user-namespace "
                "rules; this only stops seccomp answering before it is asked."
            ),
        }
    )
    return {**profile, "syscalls": kept}


def main() -> None:
    tag = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TAG
    url = SOURCE.format(tag=tag)
    with urllib.request.urlopen(url) as response:  # noqa: S310 — a pinned https URL
        profile = json.loads(response.read())

    OUTPUT.write_text(json.dumps(patch(profile), indent=2) + "\n")
    print(f"{OUTPUT.name}: Docker {tag}'s default profile, {len(NAMESPACE_SYSCALLS)} "
          f"syscalls ungated ({', '.join(NAMESPACE_SYSCALLS)})")


if __name__ == "__main__":
    main()
