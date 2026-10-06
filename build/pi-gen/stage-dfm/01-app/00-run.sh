#!/bin/bash -e
# Node.js (offizielles arm64-Archiv, auf dem Entwicklungsrechner geladen und per SHA-256 geprüft) und die Anwendung installieren.
# Die Abhängigkeiten (node_modules) wurden auf dem Entwicklungsrechner für linux/arm64 installiert – im Image wird nichts aus dem Netz geladen.
install -d "${ROOTFS_DIR}/opt/node" && tar -xJf "${DFM_NODE_TARBALL}" -C "${ROOTFS_DIR}/opt/node" --strip-components=1
rm -f "${ROOTFS_DIR}/opt/node"/{CHANGELOG.md,README.md,LICENSE} && rm -rf "${ROOTFS_DIR}/opt/node"/{include,share/doc,share/man}
install -d "${ROOTFS_DIR}/opt/dfm"
cp -a "${DFM_APP_STAGE}/." "${ROOTFS_DIR}/opt/dfm/"
