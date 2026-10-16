import «iff.def»

set_option velvet.semantics.termination "total"

prove_correct isEven by
  velvet_vcgen [isEven] with finish [Pure.isEven]

prove_correct sameParity by
  velvet_vcgen [sameParity] with (expose_names; try finish)
  simp only [Pure.sameParity, decide_eq_true_eq]
  rw [Int.tmod_eq_emod_of_nonneg require_2, Int.tmod_eq_emod_of_nonneg require_1]
  omega
