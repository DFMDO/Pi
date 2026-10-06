#!/bin/bash -e
# Node.js (offizielles arm64-Archiv, Prüfsumme fest eingetragen) und die Anwendung installieren.
NODE_VERSION="${DFM_NODE_VERSION:?}"; NODE_SHA256="${DFM_NODE_SHA256:?}"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" -o /tmp/node.tar.xz
echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -
install -d "${ROOTFS_DIR}/opt/node" && tar -xJf /tmp/node.tar.xz -C "${ROOTFS_DIR}/opt/node" --strip-components=1
rm -f "${ROOTFS_DIR}/opt/node"/{CHANGELOG.md,README.md,LICENSE} && rm -rf "${ROOTFS_DIR}/opt/node"/{include,share/doc,share/man}
install -d "${ROOTFS_DIR}/opt/dfm"
cp -a "${DFM_APP_STAGE}/." "${ROOTFS_DIR}/opt/dfm/"
# Abhängigkeiten im arm64-System selbst installieren (vorgebaute Binärdateien für better-sqlite3, sharp, argon2)
on_chroot << 'CHEOF'
cd /opt/dfm && /opt/node/bin/node /opt/node/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts=false --no-audit --no-fund
rm -rf /root/.npm /tmp/*
CHEOF
