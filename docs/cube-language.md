> Sources: [vl1991](txt/vl1991.txt), [vl1992](txt/vl1992.txt), [jvlc1996](txt/jvlc1996.txt)

# The Cube Programming Language

Summary of the Cube language as defined in three academic papers by Marc A. Najork
and Simon M. Kaplan. This document serves as a reference for implementing a Cube
variant targeting the EVB002/GA144 platform.

## Source Papers

| ID | Title | Authors | Venue | Year |
|----|-------|---------|-------|------|
| vl1991 | The CUBE Language | Najork, Kaplan | IEEE Workshop on Visual Languages | 1991 |
| vl1992 | A Prototype Implementation of the CUBE Language | Najork, Kaplan | IEEE Workshop on Visual Languages | 1992 |
| jvlc1996 | Programming in Three Dimensions | Najork | Journal of Visual Languages and Computing, 7, 219-242 | 1996 |

## 1. Overview

Cube is a **three-dimensional, visual, statically typed, higher-order logic programming
language**, designed for use in a virtual-reality-based programming environment.

Key properties:
- **Logic programming** semantics based on higher-order Horn Logic (similar to Prolog
  but higher-order and concurrent)
- **Static polymorphic type system** (Hindley-Milner style inference); well-typed
  programs are guaranteed free of run-time type errors
- **Inherently concurrent** evaluation: all solutions explored in parallel with fair
  scheduling (guaranteed to find any solution reachable in finite time)
- **Higher-order**: predicates are first-class values that can be passed as arguments
- **Dataflow**: bidirectional data propagation through pipes via unification
- **3D visual syntax**: spatial dimensions encode semantic meaning (horizontal =
  conjunction/product, vertical = disjunction/sum)

Influences: Show-and-Tell (Kimura), ESTL, Horn Logic, Prolog, Concurrent Prolog.

---

## 2. Core Syntactic Elements

### Cubes

| Element | Appearance | Corresponds to |
|---------|-----------|----------------|
| **Holder cube** | Transparent | Logic variable |
| **Predicate cube** (reference) | Opaque, icon on top | Predicate application |
| **Constructor cube** | Opaque, icon on top | Data constructor application |
| **Type cube** | Opaque grey | Type expression |
| **Integer/Float cube** | Opaque, numeral icon | Literal value |
| **Predicate definition cube** | Transparent green, icon on top | Predicate definition (clauses) |
| **Type definition cube** | Transparent grey, icon on top | Type definition (constructors) |

### Pipes

Bidirectional conduits connecting holder cubes and ports. Data flows through pipes in
**both directions simultaneously**. Connecting two holder cubes by a pipe corresponds
to unifying two logic variables.

### Ports

Cubic intrusions on the sides of predicate/constructor cubes. Each port has an icon
identifying it. Ports are special cases of holder cubes: they can be connected to pipes
and filled with values. They serve as the arguments of predicates and constructors.

### Icons

Explicit naming mechanism. A predicate definition cube carries an icon on its top; all
opaque reference cubes in the same scope carrying that icon refer to the definition.
Icons on ports match formal to actual parameters.

### Planes

Transparent boxes stacked vertically inside definition cubes:
- **In predicate definitions**: each plane = one clause. Vertical stacking = disjunction
  (OR). Contents within a plane = conjunction (AND).
- **In type definitions**: each plane = one constructor/variant. Vertical stacking = sum
  type (+). Contents within a plane = product type (x).

---

## 3. The Dataflow Metaphor

Cube uses a **dataflow metaphor based on unification** rather than assignment:

1. A value in a holder cube **flows** to all connected holder cubes through pipes
2. If the receiving holder cube is **empty**, it is filled with the value
3. If the receiving holder cube **already contains a value**, the two values must be
   **unifiable**; both cubes are then filled with the most general unifier
4. If unification **fails**, the enclosing plane fails (is removed from computation)

Pipes have **no directionality**: data can flow in both directions simultaneously. All
dataflow happens concurrently until the system reaches **equilibrium** (fixed-point).

Analogy: pipes connecting containers with different air pressures. Once opened, air
flows until all connected containers have equal pressure. The same equilibrium is
reached regardless of the order pipes are opened.

A Cube **program** (the entire virtual space) corresponds to a **query** in textual logic
programming: a conjunction of all the atomic formulas.

---

## 4. Predicate Definitions

A **predicate definition cube** is a transparent green cube with:
- An **icon** on its top naming the predicate
- **Ports** on its sides representing formal parameters
- **Planes** stacked vertically inside, each representing a clause

### Clauses (Planes)

Each plane corresponds to a Prolog clause. A plane contains:
- Holder cubes, pipes, predicate/constructor cubes (atomic formulas)
- Items arranged horizontally within a plane are **conjoined** (AND)
- Planes stacked vertically are **disjoined** (OR)

### Reference Cubes

An opaque cube with a matching icon on top refers to a predicate definition. The
intuitive meaning: the reference cube is **replaced by** (expanded to) the definition
cube. This corresponds to **call-by-name** semantics.

### Recursion

Predicate definitions may refer to themselves. A reference cube inside a definition
cube with the same icon as the enclosing cube creates a recursive predicate.

### Example: Factorial

```
fact = lambda{n:Int, n!:Int}.
  (n=0 /\ n!=1)                          -- base case (plane 1)
  \/
  (greater{arg1=n, arg2=0} /\            -- recursive case (plane 2)
   minus{arg1=n, arg2=1, res=y1} /\
   fact{n=y1, n!=y2} /\
   times{arg1=n, arg2=y2, res=n!})
```

### Example: Natural Number Generator

```
nat = lambda{out:Int}.
  (out=1)                                -- base case: 1 is natural
  \/
  (plus{arg1=y1, arg2=1, res=out} /\    -- recursive case: n+1
   nat{out=y1})
```

### Multiple Solutions

Unlike Prolog's sequential depth-first search, Cube explores all clauses **in parallel**.
A query can yield multiple (even infinite) solutions. The user browses the solution
set as it is computed.

---

## 5. Type System

### Hindley-Milner Type Inference

Cube uses a variant of the Hindley-Milner type inference algorithm. The user never
needs to declare types explicitly; the system infers all types and guarantees the
absence of run-time type errors.

### Predefined Base Types

| Type | Icon | Description |
|------|------|-------------|
| `Int` | Z | Integers |
| `Float` | R | Floating-point numbers |
| `o` | o | Propositions (success/failure) |

### Type Definitions

A **type definition cube** (grey, transparent) defines a type constructor with:
- An icon on its top naming the type constructor
- Ports on its top representing type parameters
- **Type planes** stacked vertically representing constructors (sum type)
- Type cubes within a plane representing fields (product type)

### Example: List Type

```
List alpha = nil                             -- nullary constructor
           + cons{head: alpha, tail: List alpha}  -- binary constructor
```

The `nil` constructor has no fields. The `cons` constructor has two fields: `head`
of type `alpha` (the type parameter) and `tail` of type `List alpha` (recursive).

### Constructors

Constructors are **first-class values**. They can:
- Be contained in holder cubes
- Flow through pipes
- Be passed as arguments to predicates or other constructors
- Be used for both **construction** (filling ports with values) and **deconstruction**
  (extracting values from ports via pattern matching/unification)

### Curry-Howard Correspondence

The visual similarity between predicate and type definitions reflects the Curry-Howard
isomorphism:

| Predicates | Types |
|-----------|-------|
| Conjunction (AND) = horizontal | Product type (x) = horizontal |
| Disjunction (OR) = vertical | Sum type (+) = vertical |

---

## 6. Higher-Order Features

Cube is a **higher-order** logic language:
- Predicates are first-class values
- Variables may range over predicates
- Predicates can be passed as arguments to other predicates
- Predicate and constructor applications may have variables in functor positions

However, Cube uses **first-order (syntactic) unification**: two predicates unify not if
they describe the same relation (undecidable in general), but if they have syntactically
unifying definitions.

### Example: Map

The `map` predicate takes a binary predicate `P` and two lists, and holds if both
lists are of equal length and `P` holds for all corresponding elements:

```
map = lambda{P:{a,b}->o, in:List a, out:List b}.
  (in=nil /\ out=nil)                             -- base case
  \/
  (in=cons{head=x1, tail=xs1} /\                  -- recursive case
   out=cons{head=x2, tail=xs2} /\
   P{a=x1, b=x2} /\
   map{P=P, in=xs1, out=xs2})
```

### Port Renaming

When passing a predicate to a higher-order predicate, the port icons may not match.
A **port renaming cube** (transparent, not a holder cube) wraps a predicate cube and
relabels its ports by placing new icons on its hull above the original port icons.

---

## 7. Evaluation Model

### Concurrent Execution

Cube's semantics are inherently concurrent. The interpreter maintains:

- **Configuration**: a queue of processes (different proof attempts)
- **Process**: a store + a set of threads
- **Thread**: a "lightweight process" sharing a store with other threads in the same
  process; corresponds to a goal to be proven
- **Store**: maps locations to values (instantiated terms or undefined with wait-tokens)

### Evaluation Steps

1. Pick one thread from a process and **resolve** it
2. If a thread cannot be resolved (e.g., `plus x y` with both unknowns), it is
   **suspended** and wait-tokens are attached to the unknown variables
3. When a variable is instantiated, all suspended threads with wait-tokens on that
   variable are **resumed**
4. Predicate applications are **reduced** to normal form (binding actuals to formals)
5. If the functor is an uninstantiated variable, the thread **suspends**

### Disjunction Handling

When a goal reduces to the body of a predicate definition (a disjunction of
conjunctions), the current process P is **duplicated** into m copies P1...Pm (one per
clause), and each Pi receives the threads from its clause.

### Negation

Cube has a primitive `not` predicate that is cleaner than Prolog negation:
- It **suspends** until the goal to be negated is completely ground
- Evaluation creates a concurrent sub-configuration
- Succeeds iff **all** processes in the sub-configuration fail
- Fails iff **at least one** process succeeds

### Fair Search

Unlike Prolog's depth-first search (which may not terminate), Cube uses a fair
scheduling strategy. It is **guaranteed to find every solution reachable in finite time**.

---

## 8. Textual Syntax

The following is the formal textual syntax for Cube (Table 1 from vl1991), which
provides a one-to-one correspondence with the visual 3D representation.

### Meta-variables

| Symbol | Domain |
|--------|--------|
| `K` | TypeConstructor (subset of TypeVariable) |
| `k` | Constructor (subset of NamedVariable) |
| `p` | PredicateName (subset of NamedVariable) |
| `X` | TypeVariable |
| `x` | NamedVariable = {icon1, icon2, ...} |
| `y` | UnnamedVariable = {y1, y2, ...} |
| `z` | Variable = NamedVariable union UnnamedVariable |
| `alpha_i` | UninstantiatedTypeVariable |
| `a_i` | UninstantiatedVariable |

### Type Definitions

```
tdf :: K = Lambda{X1:TYPE,...,Xm:TYPE}.V1 + ... + Vn    (m>=0, n>0)
```

### Variants (Constructors)

```
V   :: k {x1:sigma1,...,xn:sigma_n}                      (n>=0)
```

### Type Expressions

```
sigma :: X_i | K {X1=sigma1,...,Xn=sigma_n}              (n>=0)
```

### Function Types

```
tau   :: alpha_i | K {X1=tau1,...,Xn=tau_n}               (n>=0)
        | {x1:tau1,...,xn:tau_n} -> tau0                  (n>=0)
```

### Values

```
prg  :: con                                    -- a program is a conjunction
df   :: pdf | tdf                              -- definition is predicate or type def
pdf  :: p = lambda{x1:tau1,...,xk:tau_k}.df1 /\ ... /\ df_m /\
        (con1 \/ ... \/ con_n)                 (k>=0, m>=0, n>=0)
con  :: df1 /\ ... /\ df_m /\ af1 /\ ... /\ af_n   (m>=0, n>=0)
af   :: z = t | z {x1=t1,...,xn=t_n}          (n>=0)
t    :: z {x1=t1,...,xn=t_n}                  (n>=0)
     | {x1'<-x1,...,xn'<-xn}                  (port renaming)
```

### Correspondence: Visual to Textual

| Visual Element | Textual Form |
|---------------|-------------|
| Holder cube with value v | `z = v` |
| Pipe connecting z1 and z2 | `z1 = z2` (unification) |
| Predicate application | `p {arg1=val1, arg2=val2}` |
| Constructor application | `k {field1=val1, field2=val2}` |
| Predicate definition cube | `p = lambda{...}.(clause1 \/ clause2 \/ ...)` |
| Planes within definition | `clause1 \/ clause2` (disjunction) |
| Items within a plane | `af1 /\ af2` (conjunction) |
| Type definition cube | `K = Lambda{...}.V1 + ... + Vn` |
| Port renaming | `{x1'<-x1,...,xn'<-xn}` |

---

## 9. Predefined Predicates

Cube provides built-in predicates for arithmetic and logic. These predicates are
**multidirectional**: they can compute any argument from the others.

| Predicate | Ports | Behavior |
|-----------|-------|----------|
| `plus` | `{a:Int, b:Int, c:Int}` | Holds if a + b = c. Given any two, computes the third. |
| `minus` | `{a:Int, b:Int, c:Int}` | Holds if a - b = c. |
| `times` | `{a:Int, b:Int, c:Int}` | Holds if a * b = c. |
| `fplus` | `{a:Float, b:Float, c:Float}` | Float addition. |
| `ftimes` | `{a:Float, b:Float, c:Float}` | Float multiplication. |
| `greater` | `{a:Int, b:Int}` | Holds if a > b. Suspends until both ground. |
| `not` | `{goal:o}` | Holds if goal fails. Suspends until goal is ground. |
| `equal` | `{a:alpha, b:alpha}` | Unification. |

Arithmetic predicates work in either direction. For example, `plus{a=3, b=_, c=5}`
will compute `b=2`. The `times` predicate with `times{a=_, b=1.8, c=v}` will divide
`v` by `1.8` to produce `a`.

If insufficient information is available (e.g., `plus{a=_, b=_, c=_}`), the predicate
**suspends** until more values arrive through pipes.

---

## 10. Scope and Naming

### Scope Rules

- **Top-level definitions**: visible to the entire program (including each other)
- **Definitions inside a predicate definition cube**: visible to all objects inside that cube
- **Definitions inside a plane**: visible to all objects inside that plane

### Two Naming Mechanisms

1. **Pipes** (implicit naming): connect spatially close objects without requiring a name.
   Best for local connections within a predicate definition.

2. **Icons** (explicit naming): relate objects that are spatially distant. A predicate
   definition cube carries an icon; all reference cubes with that icon in the same scope
   refer to that definition.

### Naming Cubes

A **naming cube** is a special holder cube that carries an icon and defines a name for
the value (or type) inside it. Within the scope of a naming cube, all reference cubes
carrying the same icon refer to the value inside the naming cube.

---

## 11. Implementation Notes

### First Prototype (1992)

- **Front-End**: C program for 3D rendering and user interaction (X Window)
- **Back-End**: Lazy ML program for type-checking, evaluation, and visualization
- Communicate over **Unix streams**
- Rendering modes: wireframe and z-buffer with alpha-channel transparency
- Served as feasibility study and testbed

### Second Implementation (1996)

- Written entirely in **Modula-3**
- GUI built with **FormsVBT** widget set
- Custom 3D renderer on top of **X** (no 3D hardware required)
- **Dual rendering**: immediate wireframe + background high-quality rendering
- **Multi-threaded** evaluation with browsable solution set during computation
- Structural editor (primitive; programs also loadable from text files)

### Design Rationale for 3D

1. **Screen space**: 3D alleviates the screen space problem common to visual languages
2. **Graph layout**: easier to avoid overlapping arcs in 3D; users comprehend 3D
   graphs 3x better than 2D (Ware & Franck 1994)
3. **Semantic encoding**: the third dimension encodes disjunction/sum types
4. **VR interaction**: 3D notation naturally complements virtual reality environments

---

## 12. Relevance to GA144/EVB002

The Cube language's concurrent dataflow model has natural parallels to the GA144
architecture:

| Cube Concept | GA144 Parallel |
|-------------|----------------|
| Bidirectional pipes | Synchronous blocking inter-node communication ports |
| Concurrent evaluation of clauses | Multiple nodes executing in parallel |
| Suspension on uninstantiated variables | Nodes blocking on port reads/writes |
| Dataflow equilibrium | System-wide synchronization through port handshakes |
| Predicate definitions with multiple clauses | Multi-node programs with role assignment |
| Holder cubes (logic variables) | Node-local memory (64 words RAM) |
| Pipes as implicit communication | Neighbor-to-neighbor port communication |

### Spatial Mapping to GA144

When a CUBE program contains `node NNN` directives, the 3D visualization maps
node groups to the GA144's physical 18x8 grid:

| Axis | Semantic |
|------|----------|
| **X** | GA144 column (0-17, left to right) |
| **Y** | GA144 row (0-7, bottom to top) |
| **Z** | Code depth (definitions and operations within each node) |

This makes inter-node port communication (pipes) visible as spatial connections
between neighboring grid cells, reflecting the chip's physical topology.

### Visual Editing

The 3D Editor tab provides a WYSIWYG structural editor for CUBE programs.
Edits in the 3D view are synchronized bidirectionally with the text editor.

| 3D Operation | AST Equivalent |
|-------------|----------------|
| Right-click → Add Application | `addConjunctionItem(ast, path, app)` |
| Right-click → Delete | `removeConjunctionItem(ast, path)` |
| Double-click label → edit text | `updateNodeLabel(ast, path, name)` |
| Right-click → Edit Value (literal) | `updateLiteralValue(ast, path, val)` |
| Right-click → Duplicate | Deep-clone item, insert after |
| Ctrl+Z / Ctrl+Y | Undo/redo via editorStore history stack |

The serializer (`src/src/core/cube/serializer.ts`) provides the round-trip
guarantee: `parse(serialize(ast))` produces a structurally equivalent AST.
