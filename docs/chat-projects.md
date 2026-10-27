# Chat projects

Projects and Recents are separate sidebar sections. Recents contains chats without a registered project. Moving a chat to a project also changes the working directory for future messages; existing files and the chat history stay in place.

Drag a chat row onto a project folder to move it there, or onto Recents to remove its project membership while keeping its working directory. Drop targets highlight while dragging. Hover over a collapsed folder or Recents to expand it; pressing Escape cancels the drag. Busy chats cannot be moved, and existing workspace and workflow restrictions still apply.

Hover over a project to reveal its options and new-chat buttons. Right-clicking the project opens the same options:

- **Pin / Unpin** puts the project first within its section.
- **Edit** changes the displayed project name.
- **Section** moves the project into Projects or a named section. New sections appear beside Projects and Recents. Use a section's options button to rename or remove it; removing a section returns its projects to Projects.
- **Edit connection…** chooses a folder on this computer or on an SSH server.
- **Archive chats** archives the project's chats together. The archived-chats visibility control lets you find and restore them.
- **Remove project** removes the sidebar project and returns its chats to Recents. It does not delete their history or files.

Directory changes and batch archiving reject busy chats before applying changes to any member.

## SSH projects

In a new chat, open **Chat settings → Computer** to choose **This computer** or a saved SSH computer. The menu reuses connections from saved projects and chat history. Switching computers keeps the draft and attachments, selects a working directory on that computer, and clears the previous project's membership. Removing a project from the draft keeps the selected computer and directory. Local chats retain the **Current folder / Worktree** choice.

In a new chat, open the project picker and choose **New remote project**. Enter the SSH host, SessionFlow folder on the server, and remote project folder; the name is optional. Test the connection or create the project directly. Creating it selects the project for the draft without starting a provider turn. Remote projects show their SSH host in the picker and can be searched by host.

Use an existing SSH config alias or `user@hostname`. SSH uses your system SSH configuration, keys, agent, and known hosts. SessionFlow does not store SSH passwords or bypass host verification. Confirm that `ssh -o BatchMode=yes <host> true` works before connecting.

The server needs a copy of the same SessionFlow build and the provider CLI you want to use. In the remote SessionFlow checkout, run `npm install` and `npm run build:electron`. Use the repository's supported Node version for building. The **SessionFlow folder** field points to that checkout; **Remote project folder** is the directory where the provider should work. Provider login and configuration belong to the server. Local provider credentials, binary paths, and environment overrides are not copied there.

**Test connection** verifies SSH access, the runtime, and the remote directory and reports provider readiness. Saving a connection does not start a model turn. Each chat turn runs the provider through an owned SSH process, with events and interaction requests returned to the desktop.

Switching hosts starts a new provider-native conversation with context from the existing application history. The previous native binding remains recorded; application messages and files stay in place. Removing an SSH project preserves the connection on its chats so they can still continue remotely from Recents.

SSH currently supports ordinary chats. Group chats, managed worktrees, native goal controls, and the desktop's local Files / Diff / Terminal / Open folder tools are unavailable for SSH workspaces.
