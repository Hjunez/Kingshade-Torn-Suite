# Algorithms Core Notes

These notes summarize reusable principles from the uploaded Erickson algorithms text and KTH ADK exercise material. They are a retrieval guide, not a substitute for the originals.

## Complete algorithm description
For a nontrivial algorithm, separate four questions:
- What problem is being solved? State inputs, outputs, assumptions, and representation precisely.
- How does the algorithm solve it? Use an unambiguous structure.
- Why is it correct? Identify invariants, induction arguments, reductions, or exchange arguments as appropriate.
- How expensive is it? Analyze runtime and relevant resources using the correct cost model.

## Problem specification
Make hidden assumptions explicit. Separate abstract problem definition from implementation details. Define enough that another component can use the solution as a black box.

## Reduction mindset
When possible, reduce the current problem to a simpler or already-solved problem. Correctness of the caller should depend only on the contract of the subproblem, not on its internal implementation.

## Recursion and divide-and-conquer
A recursive solution needs:
- a base case;
- a strictly simpler recursive instance or other termination argument;
- a combine step when multiple subproblems are used.

For divide-and-conquer, reason about the recurrence and the work performed outside recursive calls. Use recursion-tree reasoning when appropriate.

## Dynamic programming
Start from a recurrence/state definition, identify dependencies, choose an evaluation order that guarantees dependencies are already available, then decide what state must actually be retained. Preserve predecessor information when an optimal path/solution must be reconstructed, not just its value.

## Greedy algorithms
Do not assume a locally best choice is globally optimal. A greedy algorithm needs a correctness argument, commonly an exchange argument or a structural invariant.

## Graph algorithms
Choose representation and traversal to match the problem:
- DFS: structural exploration, finishing order, cycle/topological reasoning, components.
- BFS: unweighted shortest-path layers.
- Priority-driven/best-first methods: weighted optimization families.
- MST: use established cut/cycle reasoning and standard algorithms rather than ad-hoc edge selection.
- Flow/cut: formulate capacity and conservation explicitly and use residual-graph reasoning.

## Complexity and cost models
Do not count high-level arithmetic as constant-time when operand size grows materially. Distinguish unit-cost and bit-cost models when large integers or variable-width values are involved.

Analyze worst-case behavior unless another model is explicitly justified. Track memory, messages, I/O, or other scarce resources when they matter more than CPU time.

## Lower bounds and impossibility
Decision-tree arguments, reductions, adversarial inputs, and undecidability reasoning are tools for proving that an apparently faster/general solution cannot exist under the stated model.

## NP-hardness workflow
For an NP-completeness proof:
1. Show membership in NP when applicable by defining a polynomially verifiable certificate.
2. Choose a known NP-complete problem with closely matching structure.
3. Give a polynomial-time reduction in the correct direction.
4. Prove both directions of correctness.

Do not reverse reduction direction.

## Engineering translation
For repository work, turn the theory into operational checks:
- define exact observable behavior before editing;
- identify invariants and failure modes;
- separate pure decision logic from I/O/DOM/API/storage when possible;
- use focused tests as executable correctness evidence;
- analyze whether the proposed fix worsens complexity, races, memory, or retry behavior;
- do not optimize before correctness unless measured cost is itself the defect.
