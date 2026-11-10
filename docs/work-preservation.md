# Sandbox work preservation

Armada-managed stops attempt a bounded recovery archive before removing compute.
The first version always uses encrypted server storage, even with valid GitHub
credentials: this avoids network pushes and expired-authorization failures without
changing a working branch. No remote ref is pushed or forced.

The archive contains local repository history and dirty work, not ignored files.
Archives may contain sensitive work and are encrypted with ARMADA_ENCRYPTION_KEY;
only the sandbox owner or an organization administrator can retrieve them through
`work_recovery`. Keep that encryption key available to read existing archives.

Provider-native TTL termination cannot be intercepted by this version. Armada's
lifecycle reconciler attempts preservation when it drives expiry while compute is
still available. There is no idle-stop scheduler today. Oversize, unavailable or
late capture is reported, never allowed to prevent a stop. Automatic restoration,
rescue-ref pushing and external object storage are deliberately out of scope.
