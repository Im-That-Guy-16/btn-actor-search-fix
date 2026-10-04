#!/usr/bin/env bash
# One-shot: initialise git here and push to the (already-created) GitHub repository.
# Run from inside this folder:  bash push.sh
set -e
cd "$(dirname "$0")"

git init
git branch -M main
git add -A
git commit -m "Initial commit: BTN Actor Search Fix userscript, README, avatar, licence"

# The empty project already exists at this URL.
if git remote | grep -q '^origin$'; then
  git remote set-url origin https://github.com/Im-That-Guy-16/btn-actor-search-fix.git
else
  git remote add origin https://github.com/Im-That-Guy-16/btn-actor-search-fix.git
fi

# If you use SSH instead of HTTPS, swap the line above for:
#   git remote set-url origin git@github.com:Im-That-Guy-16/btn-actor-search-fix.git

git push -u origin main
echo
echo "Done. Project: https://github.com/Im-That-Guy-16/btn-actor-search-fix"
