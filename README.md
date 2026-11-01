# Standing match

Trader A funds swap contract X with one coin. Trader B funds swap contract Y with another. Each funding is an ordinary send, and the funder does not come back to sign the trade. A third party spends X and Y together. `fulfill` has no user signature. The operator and the emulator cosign it, and only when every `require` passes.

X pays the maker on `outputs[payoutIndex]`. Y uses a different index. One output cannot satisfy both. The deposit is not a constructor field. The contract does not inspect what it holds. If Y is never funded, the coin stays in X. `cancel` returns it: the funder and the operator, no timelock. `exit` is the unilateral path after `older(serverExitDelay)`. There is no fill deadline.

## The coin the trader sends

Trader A funds the address. That output is the standing offer: carrier 330, and the pot is the sats above it.

```mermaid
flowchart LR
  traderA["Trader A<br/>the coin they send"] --> fund["fund<br/>1 in → 1 out"]
  fund --> offer["standing offer<br/>carrier 330<br/>pot above it<br/>wantAmount at payoutIndex<br/>makerWP"]
```

## The direct send

A direct send to the same address creates a second coin beside the funded offer. Only the recorded funding coin is the position.

```mermaid
flowchart LR
  sender["sender"] --> sent["direct send"]
  sent --> second["second coin<br/>same address"]
  coin["the funded offer"] --> next["recorded funding coin"]
  next --> position["the position"]
```

## The rejected transaction

Y's `fulfill` reads `outputs[payoutIndex]`. A transaction that pays the maker on the other output fails that `require`. It may not balance.

```mermaid
flowchart LR
  offerY["offer Y<br/>payoutIndex"] --> tx["rejected<br/>outputs payoutIndex program != makerWP"]
  tx --> wrong["the output the script refuses"]
```

## Who signs

`fulfill` is the server plus the function-tweaked emulator. Anyone who can build that transaction can pass the `require`. `cancel` is the funder's key and the operator. `exit` is the funder after `older(serverExitDelay)`. The maker spends `makerWP` by spending the script that output pays.

```mermaid
flowchart LR
  signs["who signs<br/>cancel: user and the operator<br/>exit: user after older serverExitDelay<br/>maker spends makerWP"]
  builds["who can build<br/>fulfill: server + function-tweaked emulator"]
```

A `require` is not authorization. It checks the transaction. It does not identify who may move the coins.

Enforced: `outputs[payoutIndex]` is a version-1 program equal to `makerWP`, carrying at least `wantAmount` of the named asset or at least `wantAmount` sats. `cancel` is the funder and the operator. `exit` waits for `serverExitDelay`.

Not claimed: operator liveness, that the deposit is any particular asset, or a destination the script does not pin.
