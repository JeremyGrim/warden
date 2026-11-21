# Skills and Agent

The plugin carries ten skills and one agent. Each skill names a gesture and runs the kit's commands. None of them checks anything Git does not already check.

| Skill | For | Who |
|---|---|---|
| `/warden:onboard` | Read the state and the rules, settle role and identity, name the next gesture | Every session |
| `/warden:setup` | Install or update the kit, and adapt its configuration | Whoever sets up the project |
| `/warden:dock` | Dock a ready branch, or bring back a refused one | Agents |
| `/warden:task` | Keep the tracking up to date with five gestures | Agents and factory |
| `/warden:proof` | Say done with proof, or NOT DONE with what remains | Agents and factory |
| `/warden:factory-setup` | Give the factory its tree, slot, cache, CPU budget and task tool | Factory |
| `/warden:factory-shift` | Run the factory's working loop | Factory |
| `/warden:train` | Run one train | Factory |
| `/warden:factory-health` | Watch disk, cache, slot, dock and worktrees | Factory |

The agent `warden:factory` ([agents/factory.md](../agents/factory.md)) is the factory's fixed profile. It preloads the factory skills, plus `task` and `proof`. Start it with `claude --agent warden:factory`.

The skills are authored in English. Their descriptions carry English and French triggers, and they answer in the person's language.

## The tracking contract

The `task` skill and the train use a task tool through five gestures:

```
<tool> status  --agent <name>
<tool> take    <task> --agent <name>
<tool> note    <task> "<text>" --agent <name>
<tool> block   <task> "<what blocks, who can unblock>" --agent <name>
<tool> deliver <task> --commit <sha> --proof "<…>" --remaining "<…>" --agent <name>
```

- Set it per workstation with `git config warden.tasks <tool>`.
- A Node script (`.mjs`, `.cjs`, `.js`) runs through Node.
- A tool with other names for the gestures maps them one to one.
- The train calls only `note`.

## The session hook

The plugin's only hook runs at session start (`hooks/session-start.mjs`). It says nothing when all is well. In a Warden repository, it says in one line when:

- the Git hooks are inactive;
- the project kit is older than the plugin;
- a new session should run `/warden:onboard`.

There is no hook on tool calls.
