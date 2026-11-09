set -euo pipefail
# Fixture only: do not install sudo, replace runner Bun, or otherwise repair the provider image.
mkdir -p /run/sshd /opt/fixture
printf '{"packageManager":"bun@1.3.14","devDependencies":{"@playwright/test":"1.56.1"}}\n' > /opt/fixture/package.json
cd /opt/fixture
/usr/bin/git init -b main
/usr/bin/git add package.json
/usr/bin/git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture
chown -R user:user /opt/fixture
