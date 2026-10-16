import «binarySearch.def»

set_option velvet.semantics.termination "total"

prove_correct sortedFrom by
  velvet_vcgen [sortedFrom] with finish

prove_correct sorted by
  velvet_vcgen [sorted] with finish

-- The two interesting VCs are the halving steps: discarding a half is sound only
-- because sortedness is monotone (`sorted_mono` in the .spec file, proved from
-- the adjacent-pair definition compiled out of the TypeScript). The rest is
-- arithmetic and is discharged inside VC generation. In the explicit halving
-- proofs, clear `require_1` before standalone `grind` calls to avoid expanding
-- the recursive sortedness definition.
prove_correct binarySearch by
  velvet_vcgen [binarySearch] with (expose_names; try finish)
  -- arr[mid] < target: nothing at or below mid can be target.
  · intro k hk0 hk
    have h := sorted_mono arr require_1 k.toNat ((lo + hi) / 2).toNat (by clear require_1; grind) (by clear require_1; grind)
    omega
  -- arr[mid] > target: nothing at or above mid can be target.
  · intro k hk hks
    have h := sorted_mono arr require_1 ((lo + hi) / 2).toNat k.toNat (by clear require_1; grind) (by clear require_1; grind)
    omega
