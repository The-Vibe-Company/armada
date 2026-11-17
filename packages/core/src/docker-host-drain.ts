/**
 * A drain is an uninstall's bounded cleanup window: the host stops taking new work while its bound
 * sandboxes are stopped and deleted. An uninstall that is interrupted leaves the flag set, so the
 * window is also its deadline: after this long the same flag stops refusing new work and the host
 * can recover without a new command. Retrying the uninstall sets a fresh window.
 */
export const DOCKER_HOST_DRAIN_SECONDS = 3600;

export const DOCKER_HOST_DRAINING_MESSAGE =
  "This host is draining for uninstall. Finish or retry the uninstall on the machine; it can take new work again after the uninstall completes or an abandoned drain expires.";
