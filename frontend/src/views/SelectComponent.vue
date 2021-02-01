<template>
    <b-modal id="modal-1" title="Создать нарезку" :ok-disabled="okEnable" @ok="sendCutRequest" @show="onModalShow">
      <b-form-select v-model="selected" :options="this.options" style="margin-bottom:10px;"></b-form-select>
      <span>Продолжительность: </span>
      <b-form-input v-model="duration" placeholder="Продолжительность"></b-form-input>  
    </b-modal>
</template>
<style scoped>

</style>
<script>
export default {
    name: "SelectComponent",
    props: ['text'],
    data(){
      return {
        duration: 0,
        fragments: [],
        options: [
          { value: null, text: 'Выберите фрагмент ' },
        ],
        selected: null
      }
    },
    computed: {
        okEnable: function(){
          return this.selected === null
        }
    },
    methods: {
        sendCutRequest(){
          let formData = new FormData();
          formData.append('narezka', JSON.stringify(this.fragments[this.selected]));
          formData.append('timeend', this.duration);
          fetch("/api/cut", {
            method: 'POST',
            body: formData
          })
          .then(()=>{

          })
          .catch(()=>{
            alert("Произошла ошибка создания нарезки!!! Проверьте консоль.");
          })
        },
        onModalShow(){
                  fetch("/api/available?post="+this.text).then((response)=>response.json())
        .then((r)=>{
          this.fragments = r[Object.keys(r)[0]];
          let counter = 0;
          this.fragments.forEach(element => {
            this.options.push({value:counter,text:element.name+" ("+element.time+")"})
            counter++;
          });
        })
        }
    },
    created(){

    }
}
</script>