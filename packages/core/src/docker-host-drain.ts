/**
 * A drain is an uninstall's cleanup window: the host stops taking new work while its bound sandboxes are
 * stopped and deleted. An uninstall that is interrupted leaves the flag set, so the host stays draining
 * until the uninstall completes; there is no deadline that re-admits work while cleanup may still be queued.
 */
export const DOCKER_HOST_DRAINING_MESSAGE =
  "This host is draining for uninstall. Finish or retry the uninstall on the machine; it takes new work again only after the uninstall completes.";
