# Projects need not be Git repositories

Registering a Project never initializes Git. Registration checks for Git
metadata at the selected checkout root and uses read-only Git commands to
resolve repository identity when that metadata exists. Selecting a subfolder
inside a Git checkout registers the selected folder.

A plain folder gets a directory main checkout at its canonical path, with no
branch or repository identity. This checkout keeps the same role in Task,
Agent Session, and Run records as a Git Project's main checkout. Worktrees,
branches, and Git diff are unavailable for directory Projects.

Directory Projects are reused by canonical path.

New project initializes a Git repository on the configured default branch,
falling back to `main`. It adds a README and attempts an initial commit. The
repository can still be registered if Git refuses the commit.

## Initialize Git later

Conversation details offers **Initialize Git** for an existing directory
Project. It runs plain `git init` in the folder, uses Git's configured default
branch, and leaves working files and history untouched. Watchtower verifies
that the folder is the root of its own main Git checkout, then sets the
repository identity and branch in one database transaction. The Project
and checkout keep their IDs, so existing Tasks and Runs keep their
checkout references. Managed No project and Coach folders are ineligible.

A folder inside another Git checkout can become the root of a separate
repository. If existing metadata points to a different checkout root,
Watchtower refuses initialization before running Git. If verification or
persistence fails after Git succeeds, the Project keeps its directory
registration and the repository stays on disk. The user can retry or
register the folder again to complete the conversion.

Registering a folder again after Git was initialized externally performs the
same database conversion using the existing Project and checkout IDs.

## No project

Watchtower creates a managed scratch root under the app profile. Draft
terminals open in the root. Each new conversation gets a directory checkout
in a child folder named for the date, the first five words of the prompt,
and a short conversation ID. Watchtower claims the folder before dispatch
and recreates it empty if it has been deleted. Side chats share their
parent's checkout.

Watchtower runs no Git commands to create or open these folders. It refuses
to enable No project if the scratch root is inside a Git checkout. Upgraded
installs keep the old scratch repository and its files. Existing chats
continue to use their original checkout and new chats get their own folders.
