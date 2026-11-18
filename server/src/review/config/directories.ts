import picomatch from "picomatch";
import type { ChangedFile } from "../core/models.ts";
import { directoryContains, type DirectorySetting } from "./schema.ts";

// The folder whose settings a change is reviewed with: only when every file it
// touches (both sides of a move) sits in that one folder. A change that also
// touches the root or a second folder gets the repository settings, so one
// review never mixes two folders' settings. Ignored files do not count, so a
// lockfile beside the folder does not pull the change out of it; the ignore
// list is the one resolved without any folder, since the folder is not chosen
// yet.
export function pickDirectory(
  directories: DirectorySetting[],
  files: Pick<ChangedFile, "path" | "previousPath">[],
  ignorePaths: string[],
): DirectorySetting | null {
  if (!directories.length) return null;
  const ignored = picomatch(ignorePaths.length ? ignorePaths : ["\0"], { dot: true });
  const paths = files
    .flatMap((file) => [file.path, file.previousPath])
    .filter((path): path is string => !!path && !ignored(path));
  if (!paths.length) return null;
  const match = directories.find((dir) => directoryContains(dir.path, paths[0]!));
  if (!match) return null;
  return paths.every((path) => directoryContains(match.path, path)) ? match : null;
}
