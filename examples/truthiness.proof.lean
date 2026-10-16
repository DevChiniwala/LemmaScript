import «truthiness.def»

set_option velvet.semantics.termination "total"

-- These functions are expression-bodied, so the Lean backend emits a `Pure.*`
-- mirror and the method just delegates (`return Pure.f x`). The verifier
-- treats that mirror as opaque, so each VC discharger supplies the mirror's
-- definition to `finish` to check the corresponding truthiness rule.

prove_correct boolCond by
  velvet_vcgen [boolCond] with finish [Pure.boolCond]

prove_correct numCond by
  velvet_vcgen [numCond] with finish [Pure.numCond]

prove_correct numNot by
  velvet_vcgen [numNot] with finish [Pure.numNot]

prove_correct numTernary by
  velvet_vcgen [numTernary] with finish [Pure.numTernary]

prove_correct strCond by
  velvet_vcgen [strCond] with finish [Pure.strCond]

prove_correct strNot by
  velvet_vcgen [strNot] with finish [Pure.strNot, String.length_eq_zero_iff]

prove_correct arrCond by
  velvet_vcgen [arrCond] with finish [Pure.arrCond]

prove_correct arrNot by
  velvet_vcgen [arrNot] with finish [Pure.arrNot]

-- `finish` also splits the optional values to reduce their postconditions.
prove_correct optNumCond by
  velvet_vcgen [optNumCond] with finish [Pure.optNumCond]

prove_correct optNumNot by
  velvet_vcgen [optNumNot] with finish [Pure.optNumNot]

prove_correct optStrCond by
  velvet_vcgen [optStrCond] with finish [Pure.optStrCond, String.length_eq_zero_iff]

prove_correct optPresent by
  velvet_vcgen [optPresent] with finish [Pure.optPresent]
