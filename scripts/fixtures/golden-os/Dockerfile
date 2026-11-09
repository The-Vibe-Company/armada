# Opt-in OS conformance fixture: real non-root SSH, exact approved sudo, Bun and Playwright setup.
FROM docker.io/library/node@sha256:aaa4b5baf1ecff3b283486bb1f90405cdda225a3e6f79660d2c559fa510a7292
RUN apt-get update && apt-get install -y --no-install-recommends     sudo=1.9.13p3-1+deb12u4 git=1:2.39.5-0+deb12u3 gh=2.23.0+dfsg1-1     openssh-server=1:9.2p1-2+deb12u10 ca-certificates=20250419~deb12u2     curl=7.88.1-10+deb12u15 unzip=6.0-28+deb12u1     && rm -rf /var/lib/apt/lists/* && rm -f /etc/ssh/ssh_host_*
RUN npm install -g bun@1.4.2     && mkdir -p /opt/armada/runtime-bun && install -m 0755 "$(readlink -f /usr/local/bin/bun)" /opt/armada/runtime-bun/bun     && useradd --create-home --shell /bin/bash --password '*' user     && printf 'user ALL=(root) NOPASSWD: ALL\n' > /etc/sudoers.d/armada-builder     && chmod 0440 /etc/sudoers.d/armada-builder     && mkdir -p /run/sshd /opt/fixture     && printf '{"packageManager":"bun@1.3.14","devDependencies":{"@playwright/test":"1.56.1"}}\n' > /opt/fixture/package.json     && cd /opt/fixture && git init -b main && git add package.json     && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture && chown -R user:user /opt/fixture     && printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/claude     && cp /usr/local/bin/claude /usr/local/bin/codex     && chmod 0755 /usr/local/bin/claude /usr/local/bin/codex
# Replace only the network location for this fixture's clone; all Git work and object scanning are real.
COPY git /usr/local/bin/git
RUN chmod 0755 /usr/local/bin/git
EXPOSE 22
CMD ["/bin/sh","-c","ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
