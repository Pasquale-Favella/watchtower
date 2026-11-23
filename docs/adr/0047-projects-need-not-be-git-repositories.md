# Projects need not be Git repositories

Registering a Project never initializes Git. Registration checks for Git
metadata at the selected checkout root and uses read-only Git commands to
resolve repository identity when that metadata exists. Selecting a subfolder
inside a Git checkout registers the selected folder.

A plain folder gets a directory main checkout at its canonical path, with no
branch or repository identity. This checkout keeps the same role in Task,
Agent Session, and Run records as a Git Project's main checkout. Worktrees,
branches, and Git diff are unavailable for directory Projects.

Directory Projects are reused by canonical path. If the folder later becomes
a Git repository, registration reuses the directory Project and preserves its
checkout. Existing Tasks and Runs keep their checkout IDs and folder paths.

New project initializes a Git repository on the configured default branch,
falling back to `main`. It adds a README and attempts an initial commit. The
repository can still be registered if Git refuses the commit.
