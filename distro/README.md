# Distribution variants

Two ways to give people the MK6 web player. **Neither includes any ROMs**: players supply their own ROM zips.

| Folder | What it is |
|---|---|
| `docker/` | Notes for the self-hosted image. The `Dockerfile` and `docker-compose.yml` are in the repository root; point the compose file at a folder of ROM zips. |
| `pages/` | Static build for GitHub Pages (or any static host). ROMs are added in the browser and stay in that browser. |

Build both from the repository root.
