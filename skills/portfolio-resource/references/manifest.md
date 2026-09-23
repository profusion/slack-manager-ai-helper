# Portfolio member manifest reference

Member overrides live at analyses[].targets[].analysisConfig.channels[].users[].

A minimal target has id, name, status, and analysisConfig.channels. Each channel has an id and optional name plus users. Each user has an id and optional name and role.

The command validates the complete manifest before writing. A user can appear on several channels. Removing without --channel removes that user from every channel override on the selected target. Moving removes the user from every source override and adds them to every destination override while avoiding duplicate user IDs.

Automatic target lifecycle rules apply after add, remove, and move:

- active plus zero configured channel users becomes paused.
- paused plus zero users before the mutation and one or more afterward becomes active.
- archived and all other statuses remain unchanged.
- --no-auto-status disables both transitions.
