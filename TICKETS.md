# Action Items from Recent PRs

This document contains tickets/issues identified from reviewing recent pull requests in the cubed repository.

## PR Review Summary

### PR #4: Enhance VGA display functionality (MERGED)
- Optimized texture updates
- Improved WebGL initialization and rendering logic
- Implemented frame management on VSYNC
- **Changes**: 2 files, +192/-64 lines

### PR #3: VGA EMU? (MERGED)
- Major UI restructuring - moved VGA display and debug controls
- Implemented VGA display with resolution detection
- Added noise display when no output
- **Changes**: 6 files, +213/-204 lines
- **Review Comments**: 3 issues identified by code review

### PR #2: SYNC - VGA Output (MERGED)
- Added VGA output support
- Introduced RecursePanel and DSL
- Added tsx dependency for compilation
- **Changes**: 22 files, +1541/-61 lines

### PR #1: cubec (MERGED)
- Added command-line CUBE compiler
- Created multiple CUBE sample programs
- **Changes**: 27 files, +2065/-880 lines

---

## High Priority Issues

### Issue 1: VGA Display - Cursor State Bug on Scale/Width Changes
**Source**: PR #3 Review Comment  
**Priority**: High  
**Component**: UI - VGA Display  
**Description**:

The "Force full redraw when user changes scale/width settings" effect sets `lastDrawnRef.current = 0`, but doesn't reset the drawing cursor or guarantee `needsFullRedraw` becomes true. When scale/width shrink, the next draw pass can start at index 0 with a non-zero cursor, producing mis-positioned pixels.

**Location**: `src/src/ui/emulator/VgaDisplay.tsx:166`

**Proposed Solution**:
Make the scale/width change path explicitly trigger a full redraw by:
- Resetting `cursorRef` when scale/width changes
- Using a separate flag that feeds into `needsFullRedraw`

**Steps to Reproduce**:
1. Load a VGA program with output
2. Change the pixel scale or manual width settings
3. Observe mis-positioned pixels in the display

**Expected Behavior**:
Display should correctly redraw all pixels from scratch when scale or width changes.

---

### Issue 2: VGA Display - Resolution Cache Mutation During Render
**Source**: PR #3 Review Comment  
**Priority**: High  
**Component**: UI - VGA Display  
**Description**:

`cachedResRef.current` is being reset/updated during render. Because React render can be invoked and abandoned (e.g., StrictMode), mutating refs here can make the cached resolution diverge from the committed UI and also causes `detectResolution` to be rescanned every render until caching happens.

**Location**: `src/src/ui/emulator/VgaDisplay.tsx:80`

**Proposed Solution**:
Move the cache update/reset into `useEffect`/`useMemo` so render stays pure and the expensive scan is controlled.

**Why This Matters**:
- Violates React rendering principles
- Can cause performance issues with repeated resolution detection
- May cause inconsistent behavior in StrictMode

---

### Issue 3: VGA Display - Incomplete Frame Detection
**Source**: PR #3 Review Comment  
**Priority**: Medium  
**Component**: UI - VGA Display  
**Description**:

`detectResolution` returns early on the second VSYNC without first folding the current line's `x` into `maxX` (and without counting a final partial line in the height). If the longest line (or the last line) doesn't end with HSYNC, width/height can be under-reported for the "complete" frame.

**Location**: `src/src/ui/emulator/VgaDisplay.tsx:36`

**Proposed Solution**:
Update `maxX`/height using the current `x` before returning on VSYNC (similar to the post-loop logic):

```typescript
if (x > maxX) maxX = x;
const height = Math.max(y + (x > 0 ? 1 : 0), 1);
return { width: maxX, height, hasSyncSignals: true, complete: true };
```

---

## Medium Priority Issues

### Issue 4: VGA Frame Buffer Memory Management
**Source**: PR #4 Analysis  
**Priority**: Medium  
**Component**: Core - GA144  
**Description**:

The frame buffer management in GA144 keeps slicing the array on each VSYNC. While this prevents unbounded growth, frequent array slicing operations could impact performance during long-running emulation sessions with high frame rates.

**Location**: `src/src/core/ga144.ts:118-124`

**Proposed Solution**:
Consider using a circular buffer or ring buffer approach for more efficient memory management:
- Fixed-size buffer for frame data
- Write pointer that wraps around
- Read pointer tracking last displayed frame

**Benefits**:
- Eliminates array reallocation overhead
- More predictable memory usage
- Better performance for high frame rate scenarios

---

### Issue 5: WebGL Resource Cleanup
**Source**: PR #4 Analysis  
**Priority**: Medium  
**Component**: UI - VGA Display  
**Description**:

The WebGL initialization and cleanup in VgaDisplay.tsx creates resources in a useEffect. While cleanup is provided, there's potential for resource leaks if the component unmounts during texture operations.

**Location**: `src/src/ui/emulator/VgaDisplay.tsx:189-209`

**Proposed Solution**:
- Add error handling for WebGL operations
- Ensure cleanup runs even if initialization fails
- Consider adding WebGL context loss handling

---

## Low Priority / Enhancement Ideas

### Issue 6: VGA Display - Add Recording/Export Feature
**Priority**: Low  
**Component**: UI - VGA Display  
**Enhancement**

**Description**:
Users might want to record or export VGA output for sharing or documentation purposes.

**Proposed Features**:
- Screenshot capture button
- GIF/video recording of VGA output
- Frame-by-frame export
- PNG sequence export

---

### Issue 7: Command-line Compiler Documentation
**Source**: PR #1 Analysis  
**Priority**: Low  
**Component**: Documentation  

**Description**:
The `cubec` command-line compiler was added in PR #1, but there's no documentation for it in the README or docs folder.

**Location**: `src/cubec`, `src/cubec.ts`

**Proposed Solution**:
Add documentation covering:
- Installation and setup
- Usage examples
- Command-line arguments
- Output format
- Integration with build systems

---

### Issue 8: Sample Programs Organization
**Source**: PR #1 Analysis  
**Priority**: Low  
**Component**: Documentation, Samples  

**Description**:
Many sample CUBE programs were added (fibonacci, md5-hash, sha256, wireframe-sphere, etc.) but there's no index or documentation explaining what each does or their complexity level.

**Proposed Solution**:
Create a `src/samples/README.md` with:
- Description of each sample
- Complexity level (beginner/intermediate/advanced)
- Key concepts demonstrated
- Expected output/behavior

---

### Issue 9: Add Tests for VGA Display Logic
**Priority**: Low  
**Component**: Testing  

**Description**:
The VGA display component has complex logic for resolution detection, frame management, and rendering but appears to lack unit tests.

**Proposed Areas for Testing**:
- Resolution detection with various HSYNC/VSYNC patterns
- Frame buffer management
- Cursor positioning logic
- Incremental vs full redraw logic

---

### Issue 10: Performance Profiling for VGA Rendering
**Priority**: Low  
**Component**: Performance  

**Description**:
With the WebGL implementation in PR #4, it would be valuable to profile the performance characteristics under various conditions.

**Proposed Tests**:
- High resolution outputs (640x480)
- High frame rates
- Memory usage over time
- Comparison between Canvas2D and WebGL approaches

---

## Documentation Improvements

### Issue 11: Update README with Recent Features
**Priority**: Low  
**Component**: Documentation  

**Description**:
The README should be updated to reflect the recent additions:
- VGA display emulation
- Command-line compiler (cubec)
- New sample programs
- RecursePanel feature

---

### Issue 12: Architecture Documentation
**Priority**: Low  
**Component**: Documentation  

**Description**:
Create architecture documentation explaining:
- VGA emulation approach
- Frame buffer management
- WebGL rendering pipeline
- Relationship between GA144 emulator and UI components

---

## Technical Debt

### Issue 13: TypeScript Strict Mode
**Priority**: Low  
**Component**: Code Quality  

**Description**:
Review and enable stricter TypeScript settings to catch potential bugs:
- `strictNullChecks`
- `noImplicitAny`
- `strictFunctionTypes`

---

### Issue 14: ESLint Configuration Review
**Priority**: Low  
**Component**: Code Quality  

**Description**:
With the codebase growing, review and update ESLint rules to maintain code quality:
- React hooks rules
- Performance best practices
- Accessibility rules for UI components

---

## Summary Statistics

- **Total Issues Identified**: 14
- **High Priority**: 3 (VGA display bugs from code review)
- **Medium Priority**: 2 (performance and resource management)
- **Low Priority**: 9 (enhancements and documentation)

**Recommended Next Steps**:
1. Address the three high-priority issues from PR #3 review comments first
2. Implement tests for VGA display logic to prevent regressions
3. Add documentation for new features (cubec, samples)
4. Consider performance optimizations for frame buffer management
