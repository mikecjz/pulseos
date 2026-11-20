import pytest

from pulseos_seq.ids import ElementId, ElementIdError, parse


@pytest.mark.parametrize("text", [
    "gre2d:excitation",
    "gre2d:excitation.rf",
    "gre2d:readout.adc@slice=0,line=64",
    "gre2d:spoil@line=3",
    "gre2d:param.TE",
])
def test_round_trip(text):
    assert str(parse(text)) == text


def test_fields():
    eid = parse("gre2d:readout.adc@slice=1,line=64")
    assert eid == ElementId("gre2d", "readout", "adc", (("slice", 1), ("line", 64)))
    assert eid.is_instance and str(eid.role_level()) == "gre2d:readout.adc"


@pytest.mark.parametrize("text", [
    "excitation", "gre2d:", "gre2d:excitation.", "gre2d:exc-itation", "gre2d:readout@line=-1",
    "gre2d:readout@line=1,line=2", "gre2d:param", "gre2d:param.TE@line=1", "2d:excitation",
])
def test_rejects_malformed(text):
    with pytest.raises(ElementIdError):
        parse(text)
