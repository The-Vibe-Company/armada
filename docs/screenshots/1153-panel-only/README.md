# #1153: the right-hand panel is the only detail mode

Before (main) on the left, after on the right, from fresh production builds of both sides with the e2e mock data.
Desktop (1280 px) and phone (390 px), light and dark; each pair shows Environments with `alice-private` open, then
after Escape (the panel closed, the URL back to the list, focus on the row).

Every list page already used the panel, so the panel itself is unchanged. The one visible difference: on desktop the
empty element that parks the closed panel no longer takes a grid row above the list, so the 16 px gap between the
attention strip and the list is gone.

![Desktop, light, closed](environments-1280-light-closed.jpg)
![Desktop, dark, open](environments-1280-dark-open.jpg)
![Desktop, light, open](environments-1280-light-open.jpg)
![Desktop, dark, closed](environments-1280-dark-closed.jpg)
![Phone, light, open](environments-390-light-open.jpg)
![Phone, dark, open](environments-390-dark-open.jpg)
![Phone, light, closed](environments-390-light-closed.jpg)
![Phone, dark, closed](environments-390-dark-closed.jpg)
