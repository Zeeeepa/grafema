# Theoretical Foundations for Grafema

**Status:** Research / Reference
**Date:** 2026-03-03
**Origin:** Brainstorm session — multi-language → Haskell → completeness → formal foundations

## The Five Abstraction Levels

```
Level 5:  COGNITIVE MODEL
          "How humans think about code"
          Theory: Cognitive Dimensions of Notations (Green & Petre, 1996)

Level 4:  PARADIGM
          "Imperative / Functional / OOP / Reactive"
          Theory: Denotational Semantics

Level 3:  SEMANTIC PROJECTIONS (CFG, DFG, Scope, Types, Structure, ...)
          "What MEANINGS we extract from code"
          Theory: Abstract Interpretation (Cousot & Cousot, 1977)

Level 2:  SEMANTIC ROLES (Callable, Invocation, Declaration, ...)
          "Cross-language operation superclasses"
          Theory: Operational Semantics

Level 1:  AST NODE TYPES (FunctionDeclaration, IfStatement, ...)
          "Concrete syntax of a specific language"
          Theory: Formal Grammars (Chomsky hierarchy)

Level 0:  SOURCE CODE (text)
```

## Key Terms and What They Mean for Grafema

### Semantic Projection

Each analysis (DFG, CFG, Scope, etc.) is a **projection** of the full program semantics onto one specific concern. Like engineering drawings: top view, side view, front view — each loses information but makes one property visible.

```
Program (full semantics)
  ├── projection → Data Flow      "where do values go"
  ├── projection → Control Flow   "in what order does code execute"
  ├── projection → Scope          "where are names visible"
  ├── projection → Call Graph     "who calls whom"
  ├── projection → Types          "what transforms into what"
  └── projection → Structure      "what is composed of what"
```

Formalized in **Abstract Interpretation**: every static analysis is an approximation of real program semantics.

### Abstract Interpretation (Cousot & Cousot, 1977)

Core concepts:
- **Concrete domain** — all possible program states (infinite)
- **Abstract domain** — simplified representation (finite, computable)
- **Galois connection** — formal link between concrete and abstract
- **Soundness** — abstraction doesn't miss real cases (may give false positives but not false negatives)

Each Grafema projection = an abstract domain. DFG abstracts "where values flow". CFG abstracts "execution order". Soundness = completeness of edge coverage.

### Operational Semantics

Formal rules for "what does this construct DO":

```
     e₁ → v₁    e₂ → v₂    v₁ + v₂ = v₃
     ────────────────────────────────────
          e₁ + e₂ → v₃
```

This IS the flow rules matrix. `AssignmentExpression: right → left` = operational semantics for assignment. Each rule in the matrix = one operational semantics rule.

### Denotational Semantics

Program = mathematical function. Not "sequence of steps" but "mapping from inputs to outputs":
- Imperative: sequence of state transformations `State → State → State`
- Functional: function composition `f ∘ g ∘ h`
- OOP: type-based dispatch `Type → Method → Result`

At this level JS and Java are the same (imperative), Haskell is different (functional). This is the level where cross-paradigm abstraction happens.

### Cognitive Dimensions of Notations (Green & Petre, 1996)

Formal vocabulary for "how humans think about code":
- **Visibility** — how easy to see the needed part → Grafema: graph queries make things findable
- **Juxtaposability** — can you compare two parts side by side → Grafema: multi-node queries
- **Hidden dependencies** — are there invisible connections → Grafema: edges make them VISIBLE
- **Progressive evaluation** — can you check incomplete results → Grafema: partial graph still useful
- **Abstraction gradient** — available abstraction levels → Grafema: node types at different granularity
- **Role-expressiveness** — how obvious is each element's role → Grafema: semantic roles on nodes

**Grafema's mission restated in Cognitive Dimensions: make hidden dependencies visible, maximize role-expressiveness, enable juxtaposability through graph queries.**

### Category Theory — The Unifying Language

Category theory describes structures and relationships BETWEEN structures:
- **Objects** = types, domains, sets (at any abstraction level)
- **Morphisms** = functions, transformations, edges
- **Functors** = mappings between abstraction levels
- **Natural transformations** = systematic ways to convert between projections

Translation AST → Graph = **functor**. Projection Graph → DFG = **functor**. Generation Graph → Haskell types = **functor**. Category theory provides unified language for all these transformations.

Steep learning curve, but provides the vocabulary to reason about ALL levels simultaneously.

## Practical Toolkit

| Level | Theory | What Grafema takes from it |
|-------|--------|---------------------------|
| AST nodes | Formal grammars | `@babel/types` spec as formal grammar |
| Semantic roles | Operational semantics | Flow rules: "what each construct does" |
| Projections | Abstract interpretation | Each analysis = abstraction, soundness = completeness |
| Paradigms | Denotational semantics | Imperative vs functional model |
| Human thinking | Cognitive Dimensions | "Make hidden dependencies visible" |
| Cross-level | Category Theory | Functors between abstraction levels |

## Grafema as "Haskell for Untyped Code"

The deeper insight: Grafema is building what Haskell's type system provides natively, but for languages that don't have it.

| Haskell (native) | Grafema (builds) |
|-------------------|------------------|
| Type signature `A -> Either E B` | Edge `FUNCTION --RETURNS--> TYPE, --THROWS--> ERROR` |
| Exhaustiveness checking | Semantic rules matrix (all cases covered) |
| Type class laws | Grafema guarantees |
| Hoogle (search by type) | `find_nodes` (search by graph) |
| Compiler rejects inconsistencies | `grafema check` rejects broken guarantees |

## Cognitive Dimensions — Full Classification with Grafema Mapping

### 14 Dimensions

Each dimension = measurable property of a notation/tool. Each maps to concrete Grafema features.

#### Already solved by Grafema

| # | Dimension | Definition | Grafema feature | Metric |
|---|-----------|-----------|-----------------|--------|
| 1 | **Hidden Dependencies** | Important links not visible in notation | Edges = visible connections; `trace_dataflow`, `find_calls` | % of cross-file dependencies surfaced vs total |
| 2 | **Visibility** | How easy to see needed components | `find_nodes`, `get_file_overview` — instant lookup | Time to find function definition: grep vs graph |
| 3 | **Hard Mental Operations** | Operations requiring high cognitive effort | `trace_dataflow` = automated reasoning through N files | # of files human must mentally traverse vs 1 query |
| 4 | **Role-Expressiveness** | How obvious is each element's purpose | Semantic roles on nodes (handler, middleware, factory) | % of nodes with meaningful semantic role metadata |
| 5 | **Abstraction Gradient** | Available abstraction levels | Zoom: module → function → expression level | # of queryable abstraction levels |

#### Partially solved

| # | Dimension | Definition | Grafema feature | Metric |
|---|-----------|-----------|-----------------|--------|
| 6 | **Juxtaposability** | Comparing two parts side by side | Multi-node Datalog queries | # of comparison queries available |
| 7 | **Viscosity** | Resistance to change | `find_calls` shows blast radius | Time to assess impact of change: manual vs graph |
| 8 | **Progressive Evaluation** | Check incomplete results | Partial graph is already useful; `grafema check` on WIP | % of guarantees checkable on partial code |
| 9 | **Error-Proneness** | Likelihood of mistakes | Guarantees catch violations pre-merge | # of violations caught by `grafema check` per sprint |
| 10 | **Closeness of Mapping** | Notation proximity to problem domain | Domain plugins (Express routes, React components) | % of domain concepts represented in graph vs only in code |

#### Future opportunities

| # | Dimension | Definition | Potential Grafema feature | Metric |
|---|-----------|-----------|--------------------------|--------|
| 11 | **Premature Commitment** | Forced decisions before info available | "Show how similar projects solved this" via graph patterns | # of reference patterns available for decision |
| 12 | **Consistency** | Similar semantics in similar syntax | Detect "same thing written differently" | # of inconsistent patterns found |
| 13 | **Diffuseness** | Verbosity of notation | Graph shows essence, not boilerplate | Compression ratio: code lines vs graph nodes |
| 14 | **Secondary Notation** | Extra meaning beyond formal (comments, naming) | Analyze naming conventions, comment patterns | % of naming conventions detected and classified |

### Supporting Cognitive Theories

**Beacons** (Brooks, 1983) — key code features that trigger instant comprehension. `app.get('/users', handler)` = "REST endpoint". Grafema domain plugins recognize beacons and label them in the graph.

**Plans and Goals** (Soloway & Ehrlich, 1984) — programmers understand code through stereotypical patterns: "accumulator pattern", "guard clause", "factory". Grafema could detect and label these.

**Information Foraging** (Pirolli & Card, 1999) — developers hunt for information following "information scent". Graph = map with direct paths instead of wandering.

**The Programmer's Brain** (Felienne Hermans, 2021) — three types of cognitive load:
- **Intrinsic** — task complexity itself (unavoidable)
- **Extraneous** — tool/environment complexity (Grafema reduces this)
- **Germane** — effort building mental model (Grafema pre-builds this)

**Grafema pre-builds the mental model (germane load) and eliminates tool friction (extraneous load), leaving developers to focus on intrinsic complexity only.**

### Product Implications

Each Cognitive Dimension = user story template:

```
As a developer working on a large codebase,
I want to [DIMENSION verb],
so that I can [reduce cognitive load / work faster / make fewer mistakes].

Examples:
- "I want to SEE all hidden dependencies of this module" (Hidden Dependencies)
- "I want to COMPARE two API handlers side by side" (Juxtaposability)
- "I want to TRACE data flow from input to database" (Hard Mental Operations)
- "I want to KNOW the blast radius before refactoring" (Viscosity)
- "I want to SEE this code at business-domain level" (Closeness of Mapping)
```

Each can be measured before/after Grafema adoption:
- Time to complete task (seconds)
- Accuracy of understanding (% correct answers about code)
- Number of files opened (proxy for cognitive load)
- Confidence rating (developer self-report)

## Evidence Base: Where These Theories Are Used in Industry

### Abstract Interpretation — FAANG Production

- **Facebook/Meta — Infer**: Static analyzer based on Abstract Interpretation. Runs on EVERY commit in Facebook mobile apps. 80% accuracy, thousands of bugs caught pre-production. Open source. Paper: [Scaling Static Analyses at Facebook (CACM 2019)](https://dl.acm.org/doi/abs/10.1145/3338112)
- **Facebook — SPARTA**: [Open-source library](https://github.com/facebook/SPARTA) for building industrial-grade analyzers on Abstract Interpretation. Powers ReDex (Android bytecode optimizer).
- **Airbus — Astrée**: Abstract Interpretation for flight software verification. Mathematically proves absence of runtime errors in airplane code.

### Cognitive Dimensions — Product Design

- **Microsoft .NET**: Used CD framework to evaluate class library usability. Found issues → redesigned API → measured improvement in second study. Paper: [Using CD Framework to Evaluate Class Library Usability (PPIG 2003)](https://www.ppig.org/files/2003-PPIG-15th-clarke.pdf)
- **Visual Studio, Eclipse**: CD framework used for IDE evaluation. Led to concrete recommendations (e.g., "high Viscosity → need automated refactoring tools").
- **Programming languages** (Haskell, Visual Basic, LabVIEW): Evaluated through CD, producing formal trade-off tables. Paper: [Usability Analysis of Visual Programming (Green & Petre)](https://web.engr.oregonstate.edu/~burnett/CS589and584/CS589-papers/CogDimsPaper.pdf)

### Program Comprehension — The Key Number

**Developers spend 58% of their time on code comprehension** — not writing, not debugging, just UNDERSTANDING code. From [large-scale field study with professionals](https://baolingfeng.github.io/papers/tsecomprehension.pdf).

```
Average developer time distribution:
  58%  — Program Comprehension (understanding code)
  24%  — Navigation (finding the right file/function)
  13%  — Other
   5%  — Editing (actually writing code)
```

Implication: a tool that speeds up comprehension by 30% saves **17% of total developer work time**. For a team of 50 developers = 8.5 FTE saved. Direct ROI for CTO.

### Cognitive Load Measurement — Established Methods

[Systematic mapping study](https://dl.acm.org/doi/abs/10.1109/ICPC.2019.00018) analyzed 4,175 articles → 63 primary studies on measuring developer cognitive load:
- 55% used EEG (electroencephalogram)
- 51% applied ML classification for predicting cognitive load
- 83% measured during programming tasks
- Self-report scales (NASA-TLX) widely used as lightweight alternative

## Metrics for Grafema — Measurable Impact

### Established Metrics (from literature)

| Metric | How to measure | What it proves | Source |
|--------|---------------|----------------|--------|
| Task completion time | Seconds to answer "what does this code do?" | Comprehension speed | ICPC papers |
| Navigation count | # files opened to answer a question about code | Search efficiency | Program comprehension studies |
| Answer accuracy | % correct answers about dependencies, data flow | Understanding quality | Hidden Dependencies dimension |
| Cognitive load | NASA-TLX self-report scale (1-21 per subscale) | Mental effort reduction | Cognitive load theory |
| Onboarding time | Days until first productive commit | New developer ramp-up | Industry standard |
| Blast radius accuracy | Can developer correctly identify all affected files? | Change impact awareness | Viscosity dimension |

### A/B Study Design for Grafema

```
Setup:
  - 20+ developers (mixed experience levels)
  - Large unfamiliar JS codebase (50k+ lines)
  - 10 comprehension tasks of increasing difficulty

Group A (control): IDE + grep + file reading
Group B (test):    IDE + grep + Grafema MCP tools

Tasks (examples):
  1. "Find where user authentication is handled"          → Visibility
  2. "What happens if this function throws?"               → Hidden Dependencies
  3. "Trace data from API input to database write"         → Hard Mental Operations
  4. "What will break if we change this interface?"         → Viscosity
  5. "How does the order processing pipeline work?"        → Closeness of Mapping

Measured:
  - Time per task (seconds)
  - Accuracy (% correct)
  - Confidence (1-5 self-report)
  - NASA-TLX cognitive load after each task
  - Files opened (navigation efficiency)

Expected results:
  - 2-5x faster on dependency/trace tasks (Hidden Dependencies, Hard Mental Ops)
  - Higher accuracy on cross-file questions
  - Lower cognitive load scores
  - Fewer files opened (graph queries vs. manual navigation)
```

### Competitive Positioning Through Evidence

No competitor measures cognitive impact:
- **CodeQL**: measures "vulnerabilities found"
- **Semgrep**: measures "rules matched"
- **Joern**: measures "query execution time"
- **Grafema**: can measure "developer comprehension speed, accuracy, and cognitive load"

This is a different conversation entirely. Not "we found 47 bugs" but "we reduced code comprehension time by 60% and onboarding by 3x, here's the peer-reviewed study."

### Academic Partnership Strategy

Target venues and partners for comprehension studies:

**Conferences:**
- ICPC (International Conference on Program Comprehension) — primary venue
- PPIG (Psychology of Programming Interest Group) — CD framework community
- ICSE (International Conference on Software Engineering) — top venue
- ESEC/FSE — empirical software engineering
- CHI — human-computer interaction (for cognitive load angle)

**Research groups (program comprehension + cognitive load):**
- TU Delft — Spoofax team (Eelco Visser's group), scope graphs, FlowSpec
- Carnegie Mellon — software engineering + HCI intersection
- Microsoft Research — developer productivity group (already measures dev time)
- JetBrains Research — IDE usability, developer tools
- University of Zurich — software evolution group

**Pitch to academics:**
"We have an open-source graph-based code analysis tool. We want to run controlled studies measuring cognitive impact using established metrics (CD framework, NASA-TLX, task completion time). We provide the tool + infrastructure. You design the study + publish the paper."

Win-win: they get a publication venue, Grafema gets peer-reviewed evidence.

## Reading List (prioritized)

1. **Cognitive Dimensions of Notations** — Green & Petre (1996). Short, readable, directly applicable.
2. **Abstract Interpretation** — Cousot & Cousot (1977). Foundational paper, but dense. Start with tutorials.
3. **Operational Semantics** — Benjamin Pierce "Types and Programming Languages" (chapters 3-5). Practical intro.
4. **Category Theory for Programmers** — Bartosz Milewski. Free online book. Best intro for developers.
5. **Denotational Semantics** — Schmidt "Denotational Semantics" or Stoy. More academic.

## Related

- [Declarative Semantic Rules Matrix](./declarative-semantic-rules.md) — the concrete spec idea
- REG-613: Java analyzer MVP
- Spoofax/FlowSpec: https://spoofax.dev/references/flowspec/
- Spoofax/Statix: https://spoofax.dev/references/statix/
