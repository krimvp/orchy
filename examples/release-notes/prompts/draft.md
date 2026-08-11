An earlier step gave the commits of the range and the patch that goes with
them. Read the patch, and not the subjects alone.

Write release notes for a reader who uses this project and did not read the
commits.

- Group the notes by what changed for the reader, not by the order of commits.
- Lead each note with what a reader can now do, or no longer must do.
- Name a fix by the fault it removes, not by the code it touched.
- Leave out a change that no reader can see, such as a rename inside a file.

Name only what the patch shows. The patch stops at its length when the range
is long, so read the code for the part it does not hold. Do not name a
feature, an option, or a field that you did not read.

If a check step gave findings, correct every one of them.

Answer with the notes as Markdown and a one-line headline.
