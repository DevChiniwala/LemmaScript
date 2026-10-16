import «majority.def»
import «majority.spec»

set_option velvet.semantics.termination "total"

prove_correct occOf by
  velvet_vcgen [occOf] with finish

prove_correct majority by
  velvet_vcgen [majority] simplifying_assumptions [occOf_zero, occOf_step]
    with finish (splits := 20)
