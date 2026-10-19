# Official Effect platform implementations own backend IO

Effect 4.0.5 now supplies compatible Node implementations, removing the availability constraint behind the earlier custom process transport and deferred FileSystem adoption. Use the official FileSystem, Path, HttpClient, and ChildProcessSpawner implementations beneath Watchtower's application capabilities. Main and worker composition roots select and share their layers; a capability declares its dependencies rather than constructing an unrelated runtime or hiding a live transport from substitution.

Watchtower retains application policy at these boundaries: Windows command routing, command exit conventions, output fanout, deadlines, protected export destinations, and provider-specific formats. A narrow native leaf remains where the portable API cannot express a required behavior, such as inspecting an export symlink without following it. Preserve cancellation draining and resource release when changing an implementation. Effect Schema remains the contract authority, and Electron continues to own application exit.

Stable package versions do not make every platform API stable. Pin the matching Effect ecosystem versions and verify upgrades against process, filesystem, SQLite, Schema, and packaged-app contracts. This decision revisits the platform-availability limitation recorded during ADR 0030's original adoption; ADRs 0032 and 0034 continue to govern backend ownership and contracts.

Implementation and verification are tracked in [issue #156](https://github.com/Pasquale-Favella/watchtower/issues/156).
