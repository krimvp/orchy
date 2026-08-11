You have the notes, the commits of the range, and the patch that goes with
them.

Check three things:

1. The patch holds every change a note names. A note that the patch and the
   code do not carry is invented, and it is a fault.
2. A change that a reader can see has a note. Read the patch and decide.
3. No note names a file, a field, or a function that a reader never calls.

Read the code when the patch stops before the change a note names. Change no
file.

Answer with `approved`, and one sentence for each fault in `findings`.
