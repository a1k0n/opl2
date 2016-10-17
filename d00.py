import sys
import struct
import json

notename = [
    'C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-']


def ReadWords(f, offs):
    ''' read array of words at offset offs terminated by 0xffff '''
    arr = []
    while True:
        x, = struct.unpack("H", f[offs:offs+2])
        offs += 2
        arr.append(x)
        if x == 0xffff:
            break
    return arr


def ReadArrangementWords(f, offs):
    ''' read array of words at offset offs terminated by 0xffff or 0xfffe '''
    arr = []
    while True:
        x, = struct.unpack("H", f[offs:offs+2])
        offs += 2
        arr.append(x)
        if x == 0xfffe:
            break
        if x == 0xffff:
            # read one more word for the loop point
            x, = struct.unpack("H", f[offs:offs+2])
            offs += 2
            arr.append(x)
            break
    return arr


def DumpSeq(seq):
    print ' '.join(["%04x" % x for x in seq])
    prefix = ''
    for s in seq:
        if s > 0x4000:   # an effect?
            prefix += "%04x" % s
            continue
        tie = ''
        if s > 0x2000:  # a tie?
            tie = '~'
            s -= 0x2000
        note = s & 0xff
        repeat = s >> 8
        prefix = "%8s " % prefix
        if note == 0:
            print prefix + '---'
            for i in range(repeat):
                print '         ---'
        else:
            if note < 0x7e:
                print prefix + notename[note % 12] + str(note / 12) + tie, note
            else:
                print prefix + '+++'
            for i in range(repeat):
                print '         +++'
        prefix = ''


def ReadD00(f):
    f = f.read()
    ptrs = struct.unpack("HHHHH", f[0x6b:0x75])
    arrangement, sequence, instrument, desc, spfx = ptrs
    arrs = struct.unpack("HHHHHHHHH", f[arrangement:arrangement+18])
    arrs = [ReadArrangementWords(f, arr) for arr in arrs]
    chvol = [ord(x) for x in f[arrangement+18:arrangement+27]]
    print 'global channel volume:', chvol

    # show arrangement
    print 'song arrangement:'
    i = 0
    maxseq = 0
    while True:
        hasdata = False
        data = []
        for j in range(9):
            if i < len(arrs[j]):
                d = arrs[j][i]
                if d < 0x8000:
                    maxseq = max(maxseq, d)
                data.append("%04x" % d)
                hasdata = True
            else:
                data.append("    ")
        i += 1
        if hasdata:
            print '%4d' % i, ' | '.join(data)
        else:
            break

    seqs = []
    maxinst = 0
    maxspfx = -1
    for n in range(maxseq+1):
        offset = sequence + 2*n
        offset, = struct.unpack("H", f[offset:offset+2])
        seq = ReadWords(f, offset)  # discard the 0xffff end marker
        seqs.append(seq)
        print '-- sequence %x' % n
        DumpSeq(seq)
        # filter for instrument commands
        print [hex(x & 0x3ff) for x in seq if (x & 0xf000) == 0xb000]
        maxspfx = max([maxspfx] + [x & 0x3ff for x in seq if (x & 0xf000) == 0xb000])
        maxinst = max([maxinst] + [x & 0x3ff for x in seq if (x & 0xf000) == 0xc000])
        # print 'seq %x' % n, ' '.join(["%04x" % w for w in seq])

    print maxspfx + 1, 'spfx'
    spfxs = []
    for i in range(maxspfx+1):
        offset = 8*i + spfx
        fx = [ord(x) for x in f[offset:offset+8]]
        maxinst = max(maxinst, fx[0])
        spfxs.append(fx)
        print i, ' '.join(["%02x" % x for x in fx])

    print maxinst + 1, 'instruments'
    instrs = []
    for i in range(maxinst+1):
        offset = 16*i + instrument
        instr = [ord(x) for x in f[offset:offset+16]]
        instrs.append(instr)
        print i, ' '.join(["%02x" % x for x in instr])

    # export song as json
    jsonSong = {
        "arrangement": arrs,
        "sequences": seqs,
        "instruments": instrs,
        "spfx": spfxs,
        "chvol": chvol,
    }

    open('song.js', 'w').write("song=" + json.dumps(jsonSong))


ReadD00(open(sys.argv[1]))
