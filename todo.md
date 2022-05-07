## scoring

### AAT Errata

Rules say that landout legs should be scored by determining the nearest point on sector and then using that to
optimize from previous sector points. Onglide uses the center point of the sector. This makes it a simple
distance calculation and works exactly the same on all circle sectors. It will not work if wedges are used
but almost all AATs use circles now

// Annex A: to the point of the next Assigned Area which is nearest to the Outlanding Position,
// less the distance from the Outlanding Position to this nearest point

BGA (2014):
		
// For Assigned Area tasks, the achieved distance of an uncompleted leg is computed as follows: -
//  Mark the nearest point on the boundary of the next area from the Out-landing point or the point at which the task time expires
//  Use this point to find the scoring point in the previous area that will maximize task distance and record the distance between them.
//  This distance, minus the distance between the Out-landing point and the next Area, is the length of the uncompleted leg.

        // and this is doing it to the centre of the sector rather than the nearest point - it will be right
        // on circular sectors but not on wedges
