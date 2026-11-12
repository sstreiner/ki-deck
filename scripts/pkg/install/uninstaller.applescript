-- "Uninstall ki-deck": the installer package puts this app into ~/Applications
-- (scripts/pkg/build.mjs compiles it with osacompile and packs a copy of bin/ki-deck
-- into its Resources). It asks once, then runs the same `ki-deck uninstall --yes` as
-- Terminal, which also removes this app. No properties or globals: an applet rewrites its own
-- script to keep them, and that would break its code signature.

on run
	set title to "ki-deck"
	set question to "Remove ki-deck?" & return & return & ¬
		"This removes Kiro's global hooks, the companion extension, the ki-deck command, the Kiro plugin in Stream Deck (Stream Deck quits for a moment) and this app." & return & return & ¬
		"Your settings, the activity log and backups stay in ~/.ki-deck. Kiro profiles stay in Stream Deck until you delete them."
	-- No default button, so a stray Return cannot start it; Escape cancels.
	display dialog question with title title buttons {"Cancel", "Uninstall"} cancel button "Cancel" with icon caution
	set command to quoted form of (POSIX path of (path to resource "ki-deck"))
	try
		do shell script "/bin/sh " & command & " uninstall --yes 2>&1"
	on error message
		display dialog "The uninstall stopped:" & return & return & message with title title buttons {"OK"} default button "OK" with icon stop
		return
	end try
	display dialog "ki-deck is removed." & return & return & ¬
		"Kiro sessions that are already running keep their hooks until they end. Reload open Kiro windows to drop the companion extension." with title title buttons {"OK"} default button "OK"
end run
