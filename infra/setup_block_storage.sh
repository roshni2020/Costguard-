#!/usr/bin/env bash
# Vultr Block Storage on sp-control: holds the SQLite DB (survives a VM rebuild) and the full IBM TabFormer CSV.
# Attach the volume in the Vultr console first (Storage -> Block Storage -> Add, same region, attach to sp-control).
# Usage: sudo bash infra/setup_block_storage.sh           (DEV=/dev/vdb MNT=/mnt/blockstorage by default)
set -euo pipefail
DEV="${DEV:-/dev/vdb}"
MNT="${MNT:-/mnt/blockstorage}"
APP_DIR="${APP_DIR:-/opt/switchproof}"
log() { printf '\n==> %s\n' "$*"; }

[ -b "$DEV" ] || { echo "No block device $DEV. Attach the volume in the Vultr console, then check: lsblk"; exit 1; }

log "Filesystem on $DEV"
if ! blkid "$DEV" >/dev/null 2>&1; then
  mkfs.ext4 -q -L switchproof "$DEV"           # only formats a blank volume
fi
UUID="$(blkid -s UUID -o value "$DEV")"
mkdir -p "$MNT"
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $MNT ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q "$MNT" || mount "$MNT"

log "Move $APP_DIR/data onto the volume"
mkdir -p "$MNT/data"
if [ -d "$APP_DIR/data" ] && [ ! -L "$APP_DIR/data" ]; then
  systemctl stop switchproof-control 2>/dev/null || true
  cp -a "$APP_DIR/data/." "$MNT/data/" && rm -rf "$APP_DIR/data"
fi
ln -sfn "$MNT/data" "$APP_DIR/data"
chown -R switchproof:switchproof "$MNT/data" 2>/dev/null || true

log "IBM TabFormer (public synthetic benchmark, ~2.3 GB CSV)"
if [ ! -f "$MNT/data/card_transaction.v1.csv" ]; then
  if curl -fL --retry 2 -o /tmp/tabformer.tgz \
       https://media.githubusercontent.com/media/IBM/TabFormer/main/data/credit_card/transactions.tgz; then
    tar -xzf /tmp/tabformer.tgz -C "$MNT/data" && rm -f /tmp/tabformer.tgz
  else
    echo "Download failed (GitHub LFS quota?). Alternative: kaggle datasets download ealtman2019/credit-card-transactions"
    echo "then unzip card_transaction.v1.csv into $MNT/data/"
  fi
fi
ls -lh "$MNT/data"

grep -q '^TABFORMER_CSV=' /etc/switchproof.env 2>/dev/null || echo "TABFORMER_CSV=$APP_DIR/data/card_transaction.v1.csv" >> /etc/switchproof.env
systemctl restart switchproof-control 2>/dev/null || true
log "Done. The Infrastructure page now shows the data directory on $DEV (Block Storage)."
